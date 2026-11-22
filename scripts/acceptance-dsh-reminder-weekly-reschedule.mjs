import assert from "node:assert/strict";
import { join } from "node:path";
import { mock } from "node:test";
import { AssistantStore } from "../packages/runtime/dist/assistant-store.js";
import { startRuntime } from "../packages/runtime/dist/runtime.js";
import { createRecurringReminderClient, createRecurringReminderRescheduleClient } from "../packages/sdk/dist/index.js";
import { exerciseHost, repo, withFixture, writeProfile } from "./fixtures/dsh-acceptance.mjs";
import { waitFor } from "./fixtures/dsh-tool-probe.mjs";

const app = "reminder-weekly-reschedule";
const patch = join(repo, `apps/dsh-plugin/${app}.patch.example.yml`);
const probe = join(repo, `scripts/fixtures/dsh-${app}-probe.mjs`);
const at = (day, time) => Date.parse(`2026-11-${day}T${time}:00+08:00`);
const timeZone = "Asia/Shanghai";
const daysOfWeek = [1, 3, 5];
const otherDays = [2, 4];
const message = "休息";
const oldTime = "09:00";
const newTime = "10:00";
const byId = (left, right) => left.id.localeCompare(right.id);

const summary = await withFixture(app, async ({ env, cwd, configDir, runNode, dshCli, version, signal }) => {
  assert.equal(version, "0.2.2-rc.1");
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  const deliveries = [];
  const expectedDeliveries = [];
  const slots = [];
  let completedScans = 0;
  const nextDue = AssistantStore.prototype.nextDue;
  const scanProbe = mock.method(AssistantStore.prototype, "nextDue", function () {
    const result = nextDue.call(this);
    // 调度器在一轮投递结束后读取下次到期时间。
    completedScans++;
    return result;
  });
  const notifier = {
    async notify(notification) {
      deliveries.push({ ...notification, now: Date.now() });
      return { status: "accepted" };
    },
  };
  mock.timers.enable({ apis: ["Date"], now: at(23, "08:00") });
  let runtime;
  let recurringTokenFile;

  async function restartAt(now) {
    await runtime?.stop();
    const scansBeforeRestart = completedScans;
    mock.timers.setTime(now);
    runtime = await startRuntime({ configDir, notifier });
    env.MANEKI_REMINDER_URL = `http://127.0.0.1:${runtime.port}`;
    return scansBeforeRestart;
  }

  const pair = async capability => (await runNode(join(repo, `packages/runtime/scripts/pair-${capability}-client.mjs`),
    configDir, String(runtime.port), "dsh-fixture", `--allow-${capability}`)).stdout.trim();
  const recurring = () => createRecurringReminderClient({ baseUrl: env.MANEKI_REMINDER_URL, tokenFile: recurringTokenFile });
  const reschedule = () => createRecurringReminderRescheduleClient({
    baseUrl: env.MANEKI_REMINDER_URL, tokenFile: env.MANEKI_REMINDER_RECURRING_RESCHEDULE_TOKEN_FILE,
  });

  async function expectTarget(seriesId, localTime, nextAt, version, days = daysOfWeek) {
    const { reminders } = await reschedule().listWeeklyTargets(deadline);
    assert.deepEqual(reminders.find(item => item.seriesId === seriesId), {
      seriesId, localTime, message, timeZone, nextAt, daysOfWeek: days, version,
    });
  }

  async function moveWithDsh(scenario, seriesId, nextAt) {
    writeProfile(env.DSH_HOME, [{ id: "probe", name: probe, config: { dshCli, scenario, seriesId } }]);
    const host = await exerciseHost(cwd, env, patch, undefined, deadline);
    assert.deepEqual(host.receipt, {
      requestId: host.input.requestId, seriesId, localTime: newTime, timeZone, nextAt, version: 2, daysOfWeek,
    });
    await expectTarget(seriesId, newTime, nextAt, 2);
    return host;
  }

  try {
    await restartAt(Date.now());
    const { version: settingsVersion, persona, cloudEnabled, chat } = runtime.assistant.settings();
    const { apiKeyConfigured: _configured, ...chatInput } = chat;
    assert.equal(runtime.assistant.updateSettings({ version: settingsVersion, persona, cloudEnabled, chat: chatInput, timeZone }).timeZone,
      timeZone);
    recurringTokenFile = await pair("reminder-recurring");
    env.MANEKI_REMINDER_RECURRING_RESCHEDULE_TOKEN_FILE = await pair("reminder-recurring-reschedule");
    env.MANEKI_REMINDER_WEEKLY_RESCHEDULE_BRIDGE = join(repo, `packages/cli/dist/${app}-mcp.js`);
    const weeklyInput = { requestId: "pending-weekly-target", localTime: oldTime, message, daysOfWeek };
    const pending = await recurring().createWeeklyReminder(weeklyInput, deadline);
    const differentDays = await recurring().createWeeklyReminder({
      ...weeklyInput, requestId: "same-message-and-time", daysOfWeek: otherDays,
    }, deadline);
    // 每日对照证明各旧、新时刻均已执行到期投递。
    const oldControl = await recurring().createDailyReminder({ requestId: "daily-old-control", localTime: oldTime, message }, deadline);
    const newControl = await recurring().createDailyReminder({ requestId: "daily-new-control", localTime: newTime, message }, deadline);

    async function verifySlot(day, time, target, ...series) {
      const now = at(day, time);
      const date = `2026-11-${day}`;
      const label = `${date} ${time}`;
      const start = deliveries.length;
      const expected = series.map(({ seriesId }) => ({
        id: `${seriesId}:${date}`, title: "小招提醒",
        body: `${message}（原定 ${new Date(now).toLocaleString("zh-CN", { timeZone })}）`, now,
      }));
      const repeated = Date.now() === now;
      const scansBeforeRestart = await restartAt(now);
      await waitFor(() => completedScans > scansBeforeRestart, `${label} 未完成调度扫描`, deadline);
      assert.deepEqual(deliveries.slice(start).sort(byId), expected.sort(byId), label);
      expectedDeliveries.push(...expected);
      const targetCalls = Number(series.includes(target));
      const otherWeeklyCalls = Number(series.includes(differentDays));
      slots.push({ date, time, repeated, targetCalls, otherWeeklyCalls, dailyCalls: series.length - targetCalls - otherWeeklyCalls });
    }

    await expectTarget(pending.seriesId, oldTime, at(23, oldTime), 1);
    const beforeClaim = await moveWithDsh("before-claim", pending.seriesId, at(23, newTime));
    await expectTarget(differentDays.seriesId, oldTime, at(24, oldTime), 1, otherDays);
    await verifySlot(23, oldTime, pending, oldControl);
    await verifySlot(23, newTime, pending, pending, newControl);
    await verifySlot(23, newTime, pending);
    await verifySlot(24, oldTime, pending, oldControl, differentDays);
    await verifySlot(24, newTime, pending, newControl);
    await expectTarget(pending.seriesId, newTime, at(25, newTime), 2);
    await verifySlot(25, oldTime, pending, oldControl);
    await verifySlot(25, newTime, pending, pending, newControl);
    await expectTarget(pending.seriesId, newTime, at(27, newTime), 2);
    assert.deepEqual(await reschedule().rescheduleWeeklyReminder(beforeClaim.input, deadline), beforeClaim.receipt);
    await recurring().cancelWeeklyReminder({ requestId: "cancel-first-scenario", seriesId: pending.seriesId }, deadline);

    const claimed = await recurring().createWeeklyReminder({ ...weeklyInput, requestId: "claimed-weekly-target" }, deadline);
    await verifySlot(27, oldTime, claimed, claimed, oldControl);
    await restartAt(at(27, "09:30"));
    await expectTarget(claimed.seriesId, oldTime, at(30, oldTime), 1);
    const afterClaim = await moveWithDsh("after-claim", claimed.seriesId, at(30, newTime));
    await verifySlot(27, newTime, claimed, newControl);
    await verifySlot(27, newTime, claimed);
    await verifySlot(30, oldTime, claimed, oldControl);
    await expectTarget(claimed.seriesId, newTime, at(30, newTime), 2);
    await verifySlot(30, newTime, claimed, claimed, newControl);
    assert.deepEqual(await reschedule().rescheduleWeeklyReminder(afterClaim.input, deadline), afterClaim.receipt);

    await runtime.stop();
    assert.deepEqual(deliveries.sort(byId), expectedDeliveries.sort(byId));
    assert.equal(new Set(deliveries.map(item => item.id)).size, deliveries.length);
    return { dsh: version, node: process.version, timeZone, beforeClaim, afterClaim, replayAfterRestart: true, notifier: "fixture", slots };
  } finally {
    try { await runtime?.stop(); } finally {
      scanProbe.mock.restore();
      mock.timers.reset();
    }
  }
});
console.log(JSON.stringify(summary, null, 2));
