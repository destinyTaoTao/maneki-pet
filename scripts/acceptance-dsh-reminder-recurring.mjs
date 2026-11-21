import assert from "node:assert/strict";
import { join } from "node:path";
import { mock } from "node:test";
import { startRuntime } from "../packages/runtime/dist/runtime.js";
import { createRecurringReminderClient } from "../packages/sdk/dist/index.js";
import { exerciseHost, repo, withFixture, writeProfile } from "./fixtures/dsh-acceptance.mjs";
import { waitFor } from "./fixtures/dsh-tool-probe.mjs";

const at = (day, hour) => Date.parse(`2026-11-${day}T${hour}:00:00+08:00`);
const timeZone = "Asia/Shanghai";
const summary = await withFixture("reminder-recurring", async ({ env, cwd, configDir, runNode, dshCli, version, signal }) => {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-21T00:30:00+08:00") });
  const deliveries = [];
  const notifier = {
    async notify(notification) {
      deliveries.push({ ...notification, now: Date.now() });
      return { status: "accepted" };
    },
  };
  const patch = join(repo, "apps/dsh-plugin/reminder-recurring.patch.example.yml");
  const probe = join(repo, "scripts/fixtures/dsh-reminder-recurring-probe.mjs");
  let runtime;
  const restartAt = async now => {
    await runtime?.stop();
    mock.timers.setTime(now);
    runtime = await startRuntime({ configDir, notifier });
    env.MANEKI_REMINDER_URL = "http://127.0.0.1:" + runtime.port;
  };
  const pair = action => runNode(join(repo, "packages/runtime/scripts/pair-reminder-recurring-client.mjs"),
    configDir, String(runtime.port), "dsh-fixture", action);
  const list = async () => (await createRecurringReminderClient({
    baseUrl: env.MANEKI_REMINDER_URL, tokenFile: env.MANEKI_REMINDER_RECURRING_TOKEN_FILE,
  }).listDailyReminders(deadline)).reminders;
  const runHost = (config, revoke) => {
    writeProfile(env.DSH_HOME, [{ id: "probe", name: probe, config: { dshCli, ...config } }]);
    return exerciseHost(cwd, env, patch, revoke, deadline);
  };
  const verifyDeliveryTimes = (...times) => {
    assert.deepEqual(deliveries.map(delivery => delivery.now), times);
    assert.equal(new Set(deliveries.map(delivery => delivery.id)).size, times.length);
    const bodies = times.map(time => `休息（原定 ${new Date(time).toLocaleString("zh-CN", { timeZone })}）`);
    assert.deepEqual(deliveries.map(delivery => delivery.body), bodies);
  };

  try {
    await restartAt(Date.now());
    const { version: settingsVersion, persona, cloudEnabled, chat } = runtime.assistant.settings();
    const { apiKeyConfigured: _configured, ...chatInput } = chat;
    assert.equal(runtime.assistant.updateSettings({ version: settingsVersion, persona, cloudEnabled, chat: chatInput, timeZone }).timeZone,
      timeZone);
    env.MANEKI_REMINDER_RECURRING_BRIDGE = join(repo, "packages/cli/dist/reminder-recurring-mcp.js");
    env.MANEKI_REMINDER_RECURRING_TOKEN_FILE = (await pair("--allow-reminder-recurring")).stdout.trim();
    const created = await runHost({});
    assert.equal(created.receipt.timeZone, timeZone);
    assert.equal(created.receipt.nextAt, at(21, "09"));
    assert.equal(created.other.nextAt, at(21, "10"));
    assert.equal(deliveries.length, 0);

    // 创建轮的 dsh 已退出。同一 SQLite 先投递九点目标，十点同名规则用来验证同日重启时调度仍运行。
    const dayOne = at(21, "09");
    const sameDayRestart = at(21, "10");
    const dayTwo = at(22, "09");
    const afterCancel = at(23, "10");
    await restartAt(dayOne);
    await waitFor(() => deliveries.length >= 1, "第一天的九点提醒未投递", deadline);
    verifyDeliveryTimes(dayOne);
    assert.equal((await list()).find(item => item.seriesId === created.receipt.seriesId).nextAt, dayTwo);

    await restartAt(sameDayRestart);
    await waitFor(() => deliveries.length >= 2, "同日重启后十点对照提醒未投递", deadline);
    verifyDeliveryTimes(dayOne, sameDayRestart);
    assert.deepEqual((await list()).map(item => item.nextAt), [dayTwo, at(22, "10")]);

    await restartAt(dayTwo);
    await waitFor(() => deliveries.length >= 3, "第二天的九点提醒未投递", deadline);
    verifyDeliveryTimes(dayOne, sameDayRestart, dayTwo);
    assert.equal((await list()).find(item => item.seriesId === created.receipt.seriesId).nextAt, at(23, "09"));

    const cancelled = await runHost({ previous: created }, () => pair("--revoke-reminder-recurring"));
    await restartAt(afterCancel);
    await waitFor(() => deliveries.length >= 4, "撤销后已安排的十点对照提醒未投递", deadline);
    await runtime.stop();
    verifyDeliveryTimes(dayOne, sameDayRestart, dayTwo, afterCancel);
    return { dsh: version, node: process.version, timeZone, created, cancelled, notifier: "fixture",
      firstAndSecondDayTargetCalls: [1, 1], sameDayRestartTargetCalls: 0, afterCancelTargetCalls: 0,
      controlCalls: 2, notificationTimes: deliveries.map(delivery => new Date(delivery.now).toISOString()) };
  } finally {
    try { await runtime?.stop(); } finally { mock.timers.reset(); }
  }
});
console.log(JSON.stringify(summary, null, 2));
