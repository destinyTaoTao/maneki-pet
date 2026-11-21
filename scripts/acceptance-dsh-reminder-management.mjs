import assert from "node:assert/strict";
import { join } from "node:path";
import { mock } from "node:test";
import { startRuntime } from "../packages/runtime/dist/runtime.js";
import { exerciseHost, repo, withFixture, writeProfile } from "./fixtures/dsh-acceptance.mjs";
import { waitFor } from "./fixtures/dsh-tool-probe.mjs";

const summary = await withFixture("reminder-management", async ({ env, cwd, configDir, runNode, dshCli, version, signal }) => {
  const startedAt = Date.now();
  mock.timers.enable({ apis: ["Date"], now: startedAt });
  const deliveries = [];
  const notifier = {
    async notify(notification) {
      deliveries.push(notification);
      return { status: "accepted" };
    },
  };
  let runtime;
  try {
    runtime = await startRuntime({ configDir, notifier });
    writeProfile(env.DSH_HOME, [{ id: "probe", name: join(repo, "scripts/fixtures/dsh-reminder-management-probe.mjs"), config: { dshCli } }]);
    const pair = (capability, action) => runNode(join(repo, `packages/runtime/scripts/pair-${capability}-client.mjs`),
      configDir, String(runtime.port), "dsh-fixture", action);
    env.MANEKI_REMINDER_URL = "http://127.0.0.1:" + runtime.port;
    const patches = [];
    for (const [capability, grant] of [["reminder", "reminder-create"], ["reminder-read", "reminder-read"], ["reminder-cancel", "reminder-cancel"]]) {
      const prefix = "MANEKI_" + capability.toUpperCase().replaceAll("-", "_");
      env[`${prefix}_BRIDGE`] = join(repo, `packages/cli/dist/${capability}-mcp.js`);
      env[`${prefix}_TOKEN_FILE`] = (await pair(capability, `--allow-${grant}`)).stdout.trim();
      patches.push(join(repo, `apps/dsh-plugin/${capability}.patch.example.yml`));
    }

    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    const result = await exerciseHost(cwd, env, patches, () => pair("reminder-cancel", "--revoke-reminder-cancel"), deadline);
    assert.equal(result.created.remindAt - startedAt, 1800000);
    assert.equal(result.other.remindAt - startedAt, 1200000);
    const rows = () => runtime.assistant.snapshot().reminders;
    assert.deepEqual(rows().map(row => [row.id, row.status]), [[result.other.reminderId, "pending"]]);
    assert.equal(deliveries.length, 0);

    // 宿主已退出。模拟两条原定时间都已过去，从同一数据库恢复真实调度器。
    await runtime.stop();
    mock.timers.setTime(result.created.remindAt);
    runtime = await startRuntime({ configDir, notifier });
    const delivered = await waitFor(() => rows().find(row => row.id === result.other.reminderId && row.status === "accepted"),
      "保留的同名提醒未投递", signal);
    assert.equal(delivered.attempts, 1);
    assert.deepEqual(rows().map(row => row.id), [result.other.reminderId]);
    assert.equal(deliveries.length, 1);
    const due = new Date(result.other.remindAt).toLocaleString("zh-CN", { timeZone: delivered.timeZone });
    assert.equal(deliveries[0].body, `休息（原定 ${due}）`);
    return { dsh: version, node: process.version, ...result, hostExited: true,
      notifier: "fixture", notificationCalls: deliveries.length, deliveredReminderId: delivered.id };
  } finally {
    try { await runtime?.stop(); } finally { mock.timers.reset(); }
  }
});
console.log(JSON.stringify(summary, null, 2));
