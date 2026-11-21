import assert from "node:assert/strict";
import { join } from "node:path";
import { mock } from "node:test";
import { startRuntime } from "../packages/runtime/dist/runtime.js";
import { exerciseHost, repo, withFixture, writeProfile } from "./fixtures/dsh-acceptance.mjs";
import { waitFor } from "./fixtures/dsh-tool-probe.mjs";

const summary = await withFixture("reminder-reschedule", async ({ env, cwd, configDir, runNode, dshCli, version, signal }) => {
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
    writeProfile(env.DSH_HOME, [{ id: "probe", name: join(repo, "scripts/fixtures/dsh-reminder-reschedule-probe.mjs"), config: { dshCli } }]);
    const pair = (capability, action) => runNode(join(repo, `packages/runtime/scripts/pair-${capability}-client.mjs`),
      configDir, String(runtime.port), "dsh-fixture", action);
    env.MANEKI_REMINDER_URL = "http://127.0.0.1:" + runtime.port;
    const patches = [];
    for (const [capability, grant] of [["reminder", "reminder-create"], ["reminder-read", "reminder-read"], ["reminder-reschedule", "reminder-reschedule"]]) {
      const prefix = "MANEKI_" + capability.toUpperCase().replaceAll("-", "_");
      env[`${prefix}_BRIDGE`] = join(repo, `packages/cli/dist/${capability}-mcp.js`);
      env[`${prefix}_TOKEN_FILE`] = (await pair(capability, `--allow-${grant}`)).stdout.trim();
      patches.push(join(repo, `apps/dsh-plugin/${capability}.patch.example.yml`));
    }

    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    const result = await exerciseHost(cwd, env, patches, () => pair("reminder-reschedule", "--revoke-reminder-reschedule"), deadline);
    assert.equal(result.other.remindAt - startedAt, 1200000);
    assert.equal(result.created.remindAt - startedAt, 1800000);
    assert.equal(result.rescheduled.remindAt - startedAt, 3600000);
    const find = receipt => runtime.assistant.snapshot().reminders.find(row => row.id === receipt.reminderId);
    const targetBefore = find(result.created);
    assert.equal(targetBefore.remindAt, result.rescheduled.remindAt);
    assert.equal(targetBefore.version, result.rescheduled.version);
    assert.equal(targetBefore.status, "pending");
    assert.equal(targetBefore.attempts, 0);
    assert.equal(deliveries.length, 0);
    const expectedBody = row => `${row.message}（原定 ${new Date(row.remindAt).toLocaleString("zh-CN", { timeZone: row.timeZone })}）`;

    // 宿主已退出。从同一数据库恢复；另一条同名提醒是旧到期点的投递对照。
    await runtime.stop();
    mock.timers.setTime(result.created.remindAt);
    runtime = await startRuntime({ configDir, notifier });
    const otherDelivered = await waitFor(() => {
      const row = find(result.other);
      return row?.status === "accepted" && row;
    }, "原到期点的同名对照提醒未投递", signal);
    assert.equal(otherDelivered.attempts, 1);
    assert.deepEqual(find(result.created), targetBefore);
    assert.deepEqual(deliveries.map(delivery => delivery.body), [expectedBody(otherDelivered)]);
    const atOriginalDue = { now: Date.now(), notificationCalls: deliveries.length, deliveredReminderId: otherDelivered.id,
      targetReminderId: targetBefore.id, targetStatus: targetBefore.status, targetAttempts: targetBefore.attempts };

    await runtime.stop();
    mock.timers.setTime(result.rescheduled.remindAt);
    runtime = await startRuntime({ configDir, notifier });
    const targetDelivered = await waitFor(() => {
      const row = find(result.created);
      return row?.status === "accepted" && row;
    }, "改期提醒在新到期点未投递", signal);
    assert.equal(targetDelivered.attempts, 1);
    assert.equal(find(result.other).attempts, 1);
    assert.deepEqual(deliveries.map(delivery => delivery.body), [expectedBody(otherDelivered), expectedBody(targetDelivered)]);
    const atNewDue = { now: Date.now(), notificationCalls: deliveries.length - atOriginalDue.notificationCalls,
      deliveredReminderId: targetDelivered.id, targetStatus: targetDelivered.status, targetAttempts: targetDelivered.attempts };

    return { dsh: version, node: process.version, ...result, hostExited: true, notifier: "fixture",
      atOriginalDue, atNewDue, totalNotificationCalls: deliveries.length };
  } finally {
    try { await runtime?.stop(); } finally { mock.timers.reset(); }
  }
});
console.log(JSON.stringify(summary, null, 2));
