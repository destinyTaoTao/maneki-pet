import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import { cpus, release, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startRuntime } from "../packages/runtime/dist/runtime.js";

// 默认通知预算每小时 30 次。样本留出余量，使用真实时钟且不弹系统横幅。
const sampleCount = 24;
const spacingMs = 300;
const tempParent = realpathSync(tmpdir());
const prefix = "maneki-reminder-timing-";
const directory = mkdtempSync(join(tempParent, prefix));
const samples = new Map();
const reminders = new Map();
const unexpected = [];
let runtime;

function post(path, input) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: runtime.port, path, method: "POST",
      signal: AbortSignal.timeout(3000), headers: {
        authorization: `Bearer ${runtime.rootToken}`, "content-type": "application/json",
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
      response.once("error", reject);
    });
    req.once("error", reject);
    req.end(JSON.stringify(input));
  });
}

try {
  runtime = await startRuntime({ configDir: directory, notifier: {
    async notify({ body, title }) {
      const calledAt = Date.now();
      const message = /^timing-\d+/.exec(body)?.[0];
      if (!message || !reminders.has(message) || samples.has(message) || title !== "小招提醒") {
        unexpected.push({ title, body });
        return { status: "failed" };
      }
      samples.set(message, calledAt - reminders.get(message));
      return { status: "accepted" };
    },
  } });
  const firstAt = Date.now() + 5000;
  for (let index = 0; index < sampleCount; index++) {
    const message = `timing-${index}`;
    const remindAt = firstAt + index * spacingMs;
    reminders.set(message, remindAt);
    assert.equal(await post("/v1/assistant/mutations", {
      requestId: message, action: "reminder.create", message, remindAt,
    }), 200);
  }
  assert.ok(Date.now() < firstAt, "未能在第一个到期时刻前完成排程");
  const deadline = firstAt + (sampleCount - 1) * spacingMs + 3000;
  while (samples.size < sampleCount && Date.now() < deadline) await delay(50);
  await runtime.stop();
  assert.deepEqual(unexpected, [], "收到重复、合批或未知的测试提醒");
  assert.equal(samples.size, sampleCount);
  const sorted = [...samples.values()].sort((a, b) => a - b);
  const p95Ms = sorted[Math.ceil(sampleCount * 0.95) - 1];
  console.log(JSON.stringify({ platform: process.platform, os: release(), cpu: cpus()[0]?.model,
    node: process.version, notifier: "fixture", spacingMs, sampleCount, p95Ms, minMs: sorted[0], maxMs: sorted.at(-1),
  }, null, 2));
  assert.ok(sorted[0] >= 0, "提醒不得提前调用通知器");
  assert.ok(p95Ms < 1000, "到通知器调用 p95 未达到 1 秒目标");
} finally {
  await runtime?.stop();
  const actual = realpathSync(directory);
  assert.equal(dirname(actual), tempParent);
  assert.equal(actual, directory);
  assert.ok(basename(actual).startsWith(prefix));
  rmSync(actual, { recursive: true, maxRetries: 5, retryDelay: 200 });
}
