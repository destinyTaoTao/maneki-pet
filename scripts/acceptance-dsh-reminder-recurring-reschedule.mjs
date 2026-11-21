import assert from "node:assert/strict";
import { join } from "node:path";
import { mock } from "node:test";
import { startRuntime } from "../packages/runtime/dist/runtime.js";
import { createRecurringReminderClient, createRecurringReminderRescheduleClient } from "../packages/sdk/dist/index.js";
import { exerciseHost, repo, withFixture, writeProfile } from "./fixtures/dsh-acceptance.mjs";
import { waitFor } from "./fixtures/dsh-tool-probe.mjs";

const at = (day, time) => Date.parse(`2026-11-${day}T${time}:00+08:00`);
const timeZone = "Asia/Shanghai";
const app = "reminder-recurring-reschedule";

async function runScenario(alreadyDelivered) {
  const name = alreadyDelivered ? "after-delivery" : "before-delivery";
  return withFixture(`${app}-${name}`, async ({ env, cwd, configDir, runNode, dshCli, version, signal }) => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    const deliveries = [];
    const notifier = {
      async notify(notification) {
        deliveries.push({ ...notification, now: Date.now() });
        return { status: "accepted" };
      },
    };
    const firstOldSlot = at(21, "09:00");
    const firstNewSlot = at(21, "10:00");
    const secondNewSlot = at(22, "10:00");
    mock.timers.enable({ apis: ["Date"], now: at(21, "08:00") });
    let runtime;
    let recurring;
    let reschedule;
    let recurringTokenFile;
    let rescheduleTokenFile;

    async function restartAt(now) {
      await runtime?.stop();
      mock.timers.setTime(now);
      runtime = await startRuntime({ configDir, notifier });
      env.MANEKI_REMINDER_URL = `http://127.0.0.1:${runtime.port}`;
      if (recurringTokenFile) recurring = createRecurringReminderClient({ baseUrl: env.MANEKI_REMINDER_URL, tokenFile: recurringTokenFile });
      if (rescheduleTokenFile) reschedule = createRecurringReminderRescheduleClient({ baseUrl: env.MANEKI_REMINDER_URL, tokenFile: rescheduleTokenFile });
    }

    const pair = async capability => (await runNode(join(repo, `packages/runtime/scripts/pair-${capability}-client.mjs`),
      configDir, String(runtime.port), "dsh-fixture", `--allow-${capability}`)).stdout.trim();

    const delivery = (series, day, time, message) => {
      const now = at(day, time);
      return { id: `${series.seriesId}:2026-11-${day}`, title: "小招提醒",
        body: `${message}（原定 ${new Date(now).toLocaleString("zh-CN", { timeZone })}）`, now };
    };

    async function verifyDeliveries(now, ...expected) {
      const start = deliveries.length;
      await restartAt(now);
      await waitFor(() => deliveries.length >= start + expected.length, "到期的每日提醒未投递", deadline);
      const byId = (left, right) => left.id.localeCompare(right.id);
      assert.deepEqual(deliveries.slice(start).sort(byId), expected.sort(byId));
    }

    try {
      await restartAt(Date.now());
      const { version: settingsVersion, persona, cloudEnabled, chat } = runtime.assistant.settings();
      const { apiKeyConfigured: _configured, ...chatInput } = chat;
      assert.equal(runtime.assistant.updateSettings({ version: settingsVersion, persona, cloudEnabled, chat: chatInput, timeZone }).timeZone,
        timeZone);
      recurringTokenFile = await pair("reminder-recurring");
      rescheduleTokenFile = await pair(app);
      const targetInput = { requestId: "daily-target", localTime: "09:00", message: "休息" };
      const controlInput = { requestId: "daily-control", localTime: alreadyDelivered ? "10:00" : "09:00",
        message: alreadyDelivered ? "休息" : "喝水" };
      const baseUrl = env.MANEKI_REMINDER_URL;
      recurring = createRecurringReminderClient({ baseUrl, tokenFile: recurringTokenFile });
      reschedule = createRecurringReminderRescheduleClient({ baseUrl, tokenFile: rescheduleTokenFile });
      const original = await recurring.createDailyReminder(targetInput, deadline);
      const control = await recurring.createDailyReminder(controlInput, deadline);
      assert.equal(original.nextAt, firstOldSlot);
      assert.equal(control.nextAt, alreadyDelivered ? firstNewSlot : firstOldSlot);

      const targetAt = async nextAt => {
        const { reminders } = await reschedule.listTargets(deadline);
        assert.deepEqual(reminders.find(row => row.seriesId === original.seriesId), {
          seriesId: original.seriesId, localTime: "10:00", message: targetInput.message, timeZone, nextAt, version: 2,
        });
      };

      if (alreadyDelivered) {
        await verifyDeliveries(firstOldSlot, delivery(original, 21, "09:00", targetInput.message));
        const { reminders } = await recurring.listDailyReminders(deadline);
        assert.equal(reminders.find(row => row.seriesId === original.seriesId).nextAt, at(22, "09:00"));
      }

      env.MANEKI_REMINDER_RECURRING_RESCHEDULE_BRIDGE = join(repo, `packages/cli/dist/${app}-mcp.js`);
      env.MANEKI_REMINDER_RECURRING_RESCHEDULE_TOKEN_FILE = rescheduleTokenFile;
      writeProfile(env.DSH_HOME, [{ id: "probe", name: join(repo, `scripts/fixtures/dsh-${app}-probe.mjs`),
        config: { dshCli, seriesId: original.seriesId } }]);
      const host = await exerciseHost(cwd, env, join(repo, `apps/dsh-plugin/${app}.patch.example.yml`), undefined, deadline);
      const nextAt = alreadyDelivered ? secondNewSlot : firstNewSlot;
      assert.deepEqual(host.receipt, {
        requestId: host.input.requestId, seriesId: original.seriesId, localTime: "10:00", timeZone, nextAt, version: 2,
      });
      await targetAt(nextAt);

      // 对照投递证明 Runtime 已扫描该时刻；用系列 ID 区分同名同时间的规则。
      if (alreadyDelivered) {
        await verifyDeliveries(firstNewSlot, delivery(control, 21, "10:00", controlInput.message));
        await targetAt(secondNewSlot);
        await verifyDeliveries(secondNewSlot, delivery(original, 22, "10:00", targetInput.message),
          delivery(control, 22, "10:00", controlInput.message));
      } else {
        await verifyDeliveries(firstOldSlot, delivery(control, 21, "09:00", controlInput.message));
        await targetAt(firstNewSlot);
        await verifyDeliveries(firstNewSlot, delivery(original, 21, "10:00", targetInput.message));
      }

      await restartAt(Date.now());
      assert.deepEqual(await reschedule.rescheduleDailyReminder(host.input, deadline), host.receipt);
      assert.deepEqual(await recurring.createDailyReminder(targetInput, deadline), original);
      await targetAt(at(alreadyDelivered ? 23 : 22, "10:00"));
      await runtime.stop();
      assert.equal(new Set(deliveries.map(item => item.id)).size, deliveries.length);
      assert.equal(deliveries.length, alreadyDelivered ? 4 : 2);
      return { scenario: name, dsh: version, node: process.version, timeZone, ...host, original, control,
        replayAfterRestart: true, notifier: "fixture", deliveries };
    } finally {
      try { await runtime?.stop(); } finally { mock.timers.reset(); }
    }
  });
}

const beforeDelivery = await runScenario(false);
const afterDelivery = await runScenario(true);
console.log(JSON.stringify({ beforeDelivery, afterDelivery }, null, 2));
