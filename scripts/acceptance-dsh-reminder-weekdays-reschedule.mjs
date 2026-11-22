import assert from "node:assert/strict";
import { join } from "node:path";
import { mock } from "node:test";
import { startRuntime } from "../packages/runtime/dist/runtime.js";
import { AssistantStore } from "../packages/runtime/dist/assistant-store.js";
import { createRecurringReminderClient, createRecurringReminderRescheduleClient } from "../packages/sdk/dist/index.js";
import { exerciseHost, repo, withFixture, writeProfile } from "./fixtures/dsh-acceptance.mjs";
import { waitFor } from "./fixtures/dsh-tool-probe.mjs";

const at = (day, time) => Date.parse(`2026-11-${day}T${time}:00+08:00`);
const timeZone = "Asia/Shanghai";
const message = "休息";
const app = "reminder-weekdays-reschedule";

async function runScenario(alreadyDelivered) {
  const scenario = alreadyDelivered ? "after-delivery" : "before-delivery";
  return withFixture(`${app}-${scenario}`, async ({ env, cwd, configDir, runNode, dshCli, version, signal }) => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
    assert.equal(version, "0.2.2-rc.1");
    const deliveries = [];
    const expectedDeliveries = [];
    const slots = [];
    let completedScans = 0;
    const nextDue = AssistantStore.prototype.nextDue;
    const scanProbe = mock.method(AssistantStore.prototype, "nextDue", function () {
      const result = nextDue.call(this);
      // 现有调度器在一轮投递结束后读取下次到期时间。
      completedScans++;
      return result;
    });
    const notifier = {
      async notify(notification) {
        deliveries.push({ ...notification, now: Date.now() });
        return { status: "accepted" };
      },
    };
    mock.timers.enable({ apis: ["Date"], now: at(20, "08:00") });
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
    const recurring = () => createRecurringReminderClient({
      baseUrl: env.MANEKI_REMINDER_URL, tokenFile: recurringTokenFile,
    });
    const reschedule = () => createRecurringReminderRescheduleClient({
      baseUrl: env.MANEKI_REMINDER_URL, tokenFile: env.MANEKI_REMINDER_RECURRING_RESCHEDULE_TOKEN_FILE,
    });
    const byId = (left, right) => left.id.localeCompare(right.id);

    try {
      await restartAt(Date.now());
      const { version: settingsVersion, persona, cloudEnabled, chat } = runtime.assistant.settings();
      const { apiKeyConfigured: _configured, ...chatInput } = chat;
      assert.equal(runtime.assistant.updateSettings({ version: settingsVersion, persona, cloudEnabled, chat: chatInput, timeZone }).timeZone,
        timeZone);
      recurringTokenFile = await pair("reminder-recurring");
      env.MANEKI_REMINDER_RECURRING_RESCHEDULE_TOKEN_FILE = await pair("reminder-recurring-reschedule");
      env.MANEKI_REMINDER_WEEKDAYS_RESCHEDULE_BRIDGE = join(repo, `packages/cli/dist/${app}-mcp.js`);
      const setup = recurring();
      const originalInput = { requestId: "weekday-target", localTime: "09:00", message };
      const original = await setup.createWeekdayReminder(originalInput, deadline);
      assert.equal(original.nextAt, at(20, "09:00"));
      // 两条同名每日规则证明每个原时刻和新时刻的扫描都实际执行。
      const oldControl = await setup.createDailyReminder({ requestId: "daily-old-control", localTime: "09:00", message }, deadline);
      const newControl = await setup.createDailyReminder({ requestId: "daily-new-control", localTime: "10:00", message }, deadline);
      const dailyTargetsBefore = await reschedule().listTargets(deadline);
      const bySeries = (left, right) => left.seriesId.localeCompare(right.seriesId);
      assert.deepEqual(dailyTargetsBefore.reminders.map(row => row.seriesId).sort(), [oldControl.seriesId, newControl.seriesId].sort());

      async function verifySlot(day, time, ...series) {
        const now = at(day, time);
        const start = deliveries.length;
        const expected = series.map(({ seriesId }) => ({
          id: `${seriesId}:2026-11-${day}`, title: "小招提醒",
          body: `${message}（原定 ${new Date(now).toLocaleString("zh-CN", { timeZone })}）`, now,
        }));
        const scansBeforeRestart = await restartAt(now);
        await waitFor(() => completedScans > scansBeforeRestart && deliveries.length >= start + expected.length,
          `未完成 ${day} 日 ${time} 的调度或到期投递`, deadline);
        assert.deepEqual(deliveries.slice(start).sort(byId), expected.sort(byId));
        expectedDeliveries.push(...expected);
        const weekdayCalls = series.filter(row => row.seriesId === original.seriesId).length;
        slots.push({ day, time, weekdayCalls, dailyCalls: series.length - weekdayCalls });
      }

      async function targetAt(localTime, nextAt, version) {
        const { reminders } = await reschedule().listWeekdayTargets(deadline);
        assert.deepEqual(reminders, [{ seriesId: original.seriesId, localTime, message, timeZone, nextAt, version }]);
      }

      if (alreadyDelivered) {
        await verifySlot(20, "09:00", original, oldControl);
        await restartAt(at(20, "09:30"));
        await targetAt("09:00", at(23, "09:00"), 1);
      }

      writeProfile(env.DSH_HOME, [{ id: "probe", name: join(repo, "scripts/fixtures/dsh-reminder-recurring-reschedule-probe.mjs"),
        config: { dshCli, seriesId: original.seriesId, weekday: true } }]);
      const host = await exerciseHost(cwd, env, join(repo, `apps/dsh-plugin/${app}.patch.example.yml`), undefined, deadline);
      const monday = at(23, "10:00");
      const nextAt = alreadyDelivered ? monday : at(20, "10:00");
      assert.deepEqual(host.receipt, {
        requestId: host.input.requestId, seriesId: original.seriesId, localTime: "10:00", timeZone, nextAt, version: 2,
      });
      await targetAt("10:00", nextAt, 2);
      const { reminders: dailyTargetsAfter } = await reschedule().listTargets(deadline);
      const oldAt = alreadyDelivered ? at(21, "09:00") : at(20, "09:00");
      assert.deepEqual(dailyTargetsAfter.sort(bySeries), dailyTargetsBefore.reminders.map(row =>
        row.seriesId === oldControl.seriesId ? { ...row, nextAt: oldAt } : row).sort(bySeries));

      if (alreadyDelivered) {
        await verifySlot(20, "10:00", newControl);
      } else {
        await verifySlot(20, "09:00", oldControl);
        await targetAt("10:00", at(20, "10:00"), 2);
        await verifySlot(20, "10:00", original, newControl);
      }
      await verifySlot(20, "10:00");
      await targetAt("10:00", monday, 2);
      assert.deepEqual(await reschedule().rescheduleWeekdayReminder(host.input, deadline), host.receipt);
      await assert.rejects(reschedule().rescheduleWeekdayReminder({
        ...host.input, requestId: "stale-after-restart", localTime: "11:00",
      }, deadline), /HTTP 409/);

      for (const day of [21, 22, 23]) {
        await verifySlot(day, "09:00", oldControl);
        await targetAt("10:00", monday, 2);
        await verifySlot(day, "10:00", newControl, ...(day === 23 ? [original] : []));
      }
      const tuesday = at(24, "10:00");
      await targetAt("10:00", tuesday, 2);
      assert.deepEqual(await reschedule().rescheduleWeekdayReminder(host.input, deadline), host.receipt);
      assert.deepEqual(await recurring().createWeekdayReminder(originalInput, deadline), original);
      await targetAt("10:00", tuesday, 2);
      await runtime.stop();
      assert.deepEqual(deliveries.sort(byId), expectedDeliveries.sort(byId));
      assert.equal(new Set(deliveries.map(item => item.id)).size, deliveries.length);

      return { scenario, dsh: version, node: process.version, timeZone, ...host, slots,
        replayAfterRestart: true, staleVersionRejectedAfterRestart: true, notifier: "fixture" };
    } finally {
      try { await runtime?.stop(); } finally {
        scanProbe.mock.restore();
        mock.timers.reset();
      }
    }
  });
}

const beforeDelivery = await runScenario(false);
const afterDelivery = await runScenario(true);
console.log(JSON.stringify({ beforeDelivery, afterDelivery }, null, 2));
