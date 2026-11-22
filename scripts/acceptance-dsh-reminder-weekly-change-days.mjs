import assert from "node:assert/strict";
import { join } from "node:path";
import { mock } from "node:test";
import { AssistantStore } from "../packages/runtime/dist/assistant-store.js";
import { startRuntime } from "../packages/runtime/dist/runtime.js";
import { createRecurringReminderClient, createRecurringReminderRescheduleClient } from "../packages/sdk/dist/index.js";
import { exerciseHost, repo, withFixture, writeProfile } from "./fixtures/dsh-acceptance.mjs";
import { waitFor } from "./fixtures/dsh-tool-probe.mjs";

const app = "reminder-weekly-change-days";
const patch = join(repo, "apps/dsh-plugin/reminder-weekly-reschedule.patch.example.yml");
const probe = join(repo, `scripts/fixtures/dsh-${app}-probe.mjs`);
const timeZone = "Asia/Shanghai";
const localTime = "10:00";
const at = (date, time = localTime) => Date.parse(`${date}T${time}:00+08:00`);
const originalDays = [1, 3, 5];
const newDays = [2, 4];
const overlapDays = [1, 2, 4];
const message = "休息";
const byId = (left, right) => left.id.localeCompare(right.id);

const summary = await withFixture(app, async ({ env, cwd, configDir, runNode, dshCli, version, signal }) => {
  assert.equal(version, "0.2.2-rc.1");
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  const deliveries = [];
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
  mock.timers.enable({ apis: ["Date"], now: at("2026-11-23", "08:00") });
  let runtime;
  let recurringTokenFile;

  async function restartAt(now) {
    await runtime?.stop();
    const scansBeforeRestart = completedScans;
    mock.timers.setTime(now);
    runtime = await startRuntime({ configDir, notifier });
    env.MANEKI_REMINDER_URL = `http://127.0.0.1:${runtime.port}`;
    await waitFor(() => completedScans > scansBeforeRestart, `${new Date(now).toISOString()} 未完成调度扫描`, deadline);
  }

  const pair = async capability => (await runNode(join(repo, `packages/runtime/scripts/pair-${capability}-client.mjs`),
    configDir, String(runtime.port), "dsh-fixture", `--allow-${capability}`)).stdout.trim();
  const recurring = () => createRecurringReminderClient({ baseUrl: env.MANEKI_REMINDER_URL, tokenFile: recurringTokenFile });
  const reschedule = () => createRecurringReminderRescheduleClient({
    baseUrl: env.MANEKI_REMINDER_URL, tokenFile: env.MANEKI_REMINDER_RECURRING_RESCHEDULE_TOKEN_FILE,
  });

  async function expectTarget(seriesId, daysOfWeek, nextAt, version) {
    const { reminders } = await reschedule().listWeeklyTargets(deadline);
    assert.deepEqual(reminders.find(item => item.seriesId === seriesId), {
      seriesId, localTime, message, timeZone, nextAt, daysOfWeek, version,
    });
  }

  async function moveWithDsh(scenario, prompt, seriesId, expectedDays, nextAt) {
    writeProfile(env.DSH_HOME, [{ id: "probe", name: probe, config: { dshCli, scenario, prompt, seriesId, expectedDays } }]);
    const host = await exerciseHost(cwd, env, patch, undefined, deadline);
    assert.deepEqual(host.receipt, {
      requestId: host.input.requestId, seriesId, localTime, timeZone, nextAt, version: 2, daysOfWeek: expectedDays,
    });
    await expectTarget(seriesId, expectedDays, nextAt, 2);
    return host;
  }

  async function expectDurableReplay({ input, receipt }) {
    assert.deepEqual(await reschedule().rescheduleWeeklyReminder({
      ...input, daysOfWeek: [...input.daysOfWeek].reverse(),
    }, deadline), receipt);
  }

  try {
    await restartAt(Date.now());
    const { version: settingsVersion, persona, cloudEnabled, chat } = runtime.assistant.settings();
    const { apiKeyConfigured: _configured, ...chatInput } = chat;
    assert.equal(runtime.assistant.updateSettings({ version: settingsVersion, persona, cloudEnabled, chat: chatInput, timeZone }).timeZone,
      timeZone);
    recurringTokenFile = await pair("reminder-recurring");
    env.MANEKI_REMINDER_RECURRING_RESCHEDULE_TOKEN_FILE = await pair("reminder-recurring-reschedule");
    env.MANEKI_REMINDER_WEEKLY_RESCHEDULE_BRIDGE = join(repo, "packages/cli/dist/reminder-weekly-reschedule-mcp.js");
    const weeklyInput = { localTime, message, daysOfWeek: originalDays };
    const pending = await recurring().createWeeklyReminder({ ...weeklyInput, requestId: "pending-weekly-target" }, deadline);
    const decoy = await recurring().createWeeklyReminder({
      ...weeklyInput, requestId: "same-message-and-time", daysOfWeek: newDays,
    }, deadline);
    // 每日对照验证每个采样时段均已执行到期投递。
    const control = await recurring().createDailyReminder({ requestId: "daily-control", localTime, message }, deadline);

    async function verifySlot(date, target, ...series) {
      const now = at(date);
      const start = deliveries.length;
      const repeated = Date.now() === now;
      const expected = series.map(({ seriesId }) => ({
        id: `${seriesId}:${date}`, title: "小招提醒",
        body: `${message}（原定 ${new Date(now).toLocaleString("zh-CN", { timeZone })}）`, now,
      }));
      await restartAt(now);
      // 调度器每轮只认领一条指定星期提醒，同一时刻可能需要多轮。
      await waitFor(async () => {
        const { reminders } = await reschedule().listWeeklyTargets(deadline);
        return reminders.every(item => item.nextAt > now);
      }, `${date} 仍有到期的指定星期提醒`, deadline);
      assert.deepEqual(deliveries.slice(start).sort(byId), expected.sort(byId), date);
      slots.push({
        date, localTime, repeated, targetCalls: Number(series.includes(target)),
        decoyCalls: Number(series.includes(decoy)), dailyCalls: Number(series.includes(control)),
      });
    }

    await expectTarget(pending.seriesId, originalDays, at("2026-11-23"), 1);
    const beforeClaim = await moveWithDsh("before-claim", "把每周一、三、五上午十点的休息提醒改成每周二、四上午十点",
      pending.seriesId, newDays, at("2026-11-24"));
    await expectTarget(decoy.seriesId, newDays, at("2026-11-24"), 1);
    await verifySlot("2026-11-23", pending, control);
    await verifySlot("2026-11-24", pending, control, decoy, pending);
    await verifySlot("2026-11-24", pending);
    await verifySlot("2026-11-25", pending, control);
    await verifySlot("2026-11-26", pending, control, decoy, pending);
    await verifySlot("2026-11-26", pending);
    await verifySlot("2026-11-27", pending, control);
    await expectTarget(pending.seriesId, newDays, at("2026-12-01"), 2);
    await expectDurableReplay(beforeClaim);
    await recurring().cancelWeeklyReminder({ requestId: "cancel-first-scenario", seriesId: pending.seriesId }, deadline);

    const claimed = await recurring().createWeeklyReminder({ ...weeklyInput, requestId: "claimed-weekly-target" }, deadline);
    await verifySlot("2026-11-30", claimed, control, claimed);
    await restartAt(at("2026-11-30", "09:30"));
    await expectTarget(claimed.seriesId, originalDays, at("2026-12-02"), 1);
    const afterClaim = await moveWithDsh("after-claim", "把每周一、三、五上午十点的休息提醒改成每周一、二、四上午十点",
      claimed.seriesId, overlapDays, at("2026-12-01"));
    await verifySlot("2026-11-30", claimed);
    await verifySlot("2026-11-30", claimed);
    await verifySlot("2026-12-01", claimed, control, decoy, claimed);
    await verifySlot("2026-12-01", claimed);
    await expectTarget(claimed.seriesId, overlapDays, at("2026-12-03"), 2);
    await expectDurableReplay(afterClaim);

    await runtime.stop();
    assert.equal(deliveries.length, slots.reduce((total, slot) => total + slot.targetCalls + slot.decoyCalls + slot.dailyCalls, 0));
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
