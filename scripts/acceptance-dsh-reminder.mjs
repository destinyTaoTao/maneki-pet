import assert from "node:assert/strict";
import { join } from "node:path";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startRuntime } from "../packages/runtime/dist/runtime.js";
import { WindowsSystemNotifier } from "../packages/runtime/dist/system-notifier.js";
import { exerciseHost, repo, withFixture, writeProfile } from "./fixtures/dsh-acceptance.mjs";
import { waitFor } from "./fixtures/dsh-tool-probe.mjs";

assert.equal(process.platform, "win32", "本脚本验收 Windows 系统通知");
const summary = await withFixture("reminder", async ({ env, cwd, configDir, runNode, dshCli, version, signal }) => {
  const startedAt = Date.now();
  mock.timers.enable({ apis: ["Date"], now: startedAt }); // 仅控制当前进程的墙钟，调度器继续使用真实定时器。
  const windows = new WindowsSystemNotifier();
  const calls = [];
  const notifier = {
    notify(input) {
      calls.push({ at: Date.now(), body: input.body });
      assert.equal(calls.length, 1, "同一提醒重复调用系统通知");
      return windows.notify(input);
    },
  };
  let runtime;
  try {
    runtime = await startRuntime({ configDir, notifier });
    writeProfile(env.DSH_HOME, [{ id: "probe", name: join(repo, "scripts/fixtures/dsh-reminder-probe.mjs"), config: { dshCli } }]);
    const pair = action => runNode(join(repo, "packages/runtime/scripts/pair-reminder-client.mjs"),
      configDir, String(runtime.port), "dsh-fixture", action);
    env.MANEKI_REMINDER_URL = "http://127.0.0.1:" + runtime.port;
    env.MANEKI_REMINDER_BRIDGE = join(repo, "packages/cli/dist/reminder-mcp.js");
    env.MANEKI_REMINDER_TOKEN_FILE = (await pair("--allow-reminder-create")).stdout.trim();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    const result = await exerciseHost(cwd, env, join(repo, "apps/dsh-plugin/reminder.patch.example.yml"),
      () => pair("--revoke-reminder-create"), deadline);
    const { reminderId, remindAt } = result.receipt;
    assert.equal(remindAt - startedAt, 1800000);
    const rows = () => runtime.assistant.snapshot().reminders;
    assert.equal(rows().length, 1);
    assert.equal(rows()[0].id, reminderId);
    assert.equal(rows()[0].message, "休息");
    assert.equal(rows()[0].remindAt, remindAt);
    assert.equal(rows()[0].status, "pending");
    assert.equal(calls.length, 0);

    // 宿主已正常退出。距到期一秒时重启后台，从同一 SQLite 恢复并自行调度。
    await runtime.stop();
    mock.timers.setTime(remindAt - 1000);
    runtime = await startRuntime({ configDir, notifier });
    await delay(100);
    assert.equal(rows()[0].status, "pending");
    assert.equal(calls.length, 0);
    mock.timers.setTime(remindAt);
    const delivery = await waitFor(() => {
      const item = rows()[0];
      return ["accepted", "failed"].includes(item.status) && item;
    }, "通知未结束投递", signal, 12000);
    assert.equal(delivery.status, "accepted", delivery.code ?? "Windows 未受理通知");
    assert.equal(delivery.seenAt, null);
    assert.equal(delivery.attempts, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0].body, /休息/);
    assert.equal(calls[0].at, remindAt);
    await runtime.stop();
    runtime = await startRuntime({ configDir, notifier });
    await delay(150);
    assert.equal(rows()[0].status, "accepted");
    assert.equal(rows()[0].attempts, 1);
    assert.equal(calls.length, 1);
    return { dsh: version, node: process.version, ...result, delaySeconds: 1800, hostExited: true,
      windows: delivery.status, notificationCalls: calls.length, seenAt: delivery.seenAt };
  } finally {
    try { await runtime?.stop(); } finally { mock.timers.reset(); }
  }
});
console.log(JSON.stringify(summary, null, 2));
