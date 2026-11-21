import assert from "node:assert/strict";
import { join } from "node:path";
import { mock } from "node:test";
import { startRuntime } from "../packages/runtime/dist/runtime.js";
import { createRecurringReminderClient } from "../packages/sdk/dist/index.js";
import { exerciseHost, repo, withFixture, writeProfile } from "./fixtures/dsh-acceptance.mjs";
import { waitFor } from "./fixtures/dsh-tool-probe.mjs";

const at = (day, hour) => Date.parse(`2026-11-${day}T${hour}:00:00+08:00`);
const timeZone = "Asia/Shanghai";
const target = "休息";
const control = "每日对照";
const summary = await withFixture("reminder-weekdays", async ({ env, cwd, configDir, runNode, dshCli, version, signal }) => {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  const fridayStart = at(20, "08");
  mock.timers.enable({ apis: ["Date"], now: fridayStart });
  const deliveries = [];
  const notifier = {
    async notify(notification) {
      deliveries.push({ ...notification, now: Date.now() });
      return { status: "accepted" };
    },
  };
  const patch = join(repo, "apps/dsh-plugin/reminder-weekdays.patch.example.yml");
  const probe = join(repo, "scripts/fixtures/dsh-reminder-weekdays-probe.mjs");
  let runtime;
  const restartAt = async now => {
    await runtime?.stop();
    mock.timers.setTime(now);
    runtime = await startRuntime({ configDir, notifier });
    env.MANEKI_REMINDER_URL = "http://127.0.0.1:" + runtime.port;
  };
  const client = () => createRecurringReminderClient({
    baseUrl: env.MANEKI_REMINDER_URL, tokenFile: env.MANEKI_REMINDER_RECURRING_TOKEN_FILE,
  });
  const weekdays = async () => (await client().listWeekdayReminders(deadline)).reminders;
  const runHost = config => {
    writeProfile(env.DSH_HOME, [{ id: "probe", name: probe, config: { dshCli, ...config } }]);
    return exerciseHost(cwd, env, patch, undefined, deadline);
  };
  const expectDeliveryAt = async (now, message) => {
    const before = deliveries.length;
    await restartAt(now);
    await waitFor(() => deliveries.length > before, `${message}在 ${new Date(now).toISOString()} 未投递`, deadline);
    const body = `${message}（原定 ${new Date(now).toLocaleString("zh-CN", { timeZone })}）`;
    const received = deliveries.slice(before);
    assert.deepEqual(received.map(item => [item.now, item.body]), [[now, body]]);
    return { at: new Date(now).toISOString(), weekdayCalls: Number(message === target), dailyCalls: Number(message === control) };
  };

  try {
    await restartAt(fridayStart);
    const { version: settingsVersion, persona, cloudEnabled, chat } = runtime.assistant.settings();
    const { apiKeyConfigured: _configured, ...chatInput } = chat;
    assert.equal(runtime.assistant.updateSettings({ version: settingsVersion, persona, cloudEnabled, chat: chatInput, timeZone }).timeZone,
      timeZone);
    env.MANEKI_REMINDER_RECURRING_TOKEN_FILE = (await runNode(
      join(repo, "packages/runtime/scripts/pair-reminder-recurring-client.mjs"),
      configDir, String(runtime.port), "dsh-fixture", "--allow-reminder-recurring",
    )).stdout.trim();
    env.MANEKI_REMINDER_WEEKDAYS_BRIDGE = join(repo, "packages/cli/dist/reminder-weekdays-mcp.js");

    // 每日十点对照证明周末和取消后的调度仍在运行。
    const daily = await client().createDailyReminder({ requestId: "daily-control", localTime: "10:00", message: control }, deadline);
    assert.equal(daily.nextAt, at(20, "10"));
    const created = await runHost({});
    assert.equal(created.receipt.timeZone, timeZone);
    assert.equal(created.receipt.localTime, "09:00");
    assert.equal(created.receipt.nextAt, at(20, "09"));
    assert.equal(deliveries.length, 0);

    const friday = await expectDeliveryAt(at(20, "09"), target);
    assert.deepEqual((await weekdays()).map(item => item.nextAt), [at(23, "09")]);
    const sameDayRestart = await expectDeliveryAt(at(20, "10"), control);
    const saturday = await expectDeliveryAt(at(21, "10"), control);
    assert.deepEqual((await weekdays()).map(item => item.nextAt), [at(23, "09")]);
    const sunday = await expectDeliveryAt(at(22, "10"), control);
    assert.deepEqual((await weekdays()).map(item => item.nextAt), [at(23, "09")]);
    const monday = await expectDeliveryAt(at(23, "09"), target);
    assert.deepEqual((await weekdays()).map(item => item.nextAt), [at(24, "09")]);
    const cancelled = await runHost({ previous: created });
    const tuesday = await expectDeliveryAt(at(24, "10"), control);
    assert.deepEqual(await weekdays(), []);
    await runtime.stop();
    assert.deepEqual(deliveries.map(item => new Date(item.now).toISOString()),
      [friday, sameDayRestart, saturday, sunday, monday, tuesday].map(step => step.at));
    assert.equal(new Set(deliveries.map(item => item.id)).size, 6);

    return { dsh: version, node: process.version, timeZone, created, cancelled, notifier: "fixture",
      friday, sameDayRestart, saturday, sunday, monday, tuesday };
  } finally {
    try { await runtime?.stop(); } finally { mock.timers.reset(); }
  }
});
console.log(JSON.stringify(summary, null, 2));
