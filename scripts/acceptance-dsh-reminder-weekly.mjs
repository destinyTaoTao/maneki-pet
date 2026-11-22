import assert from "node:assert/strict";
import { join } from "node:path";
import { mock } from "node:test";
import { AssistantStore } from "../packages/runtime/dist/assistant-store.js";
import { startRuntime } from "../packages/runtime/dist/runtime.js";
import { createRecurringReminderClient } from "../packages/sdk/dist/index.js";
import { exerciseHost, repo, withFixture, writeProfile } from "./fixtures/dsh-acceptance.mjs";
import { waitFor } from "./fixtures/dsh-tool-probe.mjs";

const at = (day, time = "09:00") => Date.parse(`2026-11-${day}T${time}:00+08:00`);
const timeZone = "Asia/Shanghai";
const start = at(22, "08:00");
const patch = join(repo, "apps/dsh-plugin/reminder-weekly.patch.example.yml");
const probe = join(repo, "scripts/fixtures/dsh-reminder-weekly-probe.mjs");

const summary = await withFixture("reminder-weekly", async ({ env, cwd, configDir, runNode, dshCli, version, signal }) => {
  assert.equal(version, "0.2.2-rc.1");
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
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
  mock.timers.enable({ apis: ["Date"], now: start });
  let runtime;

  async function restartAt(now) {
    await runtime?.stop();
    const scansBeforeRestart = completedScans;
    mock.timers.setTime(now);
    runtime = await startRuntime({ configDir, notifier });
    env.MANEKI_REMINDER_URL = `http://127.0.0.1:${runtime.port}`;
    return scansBeforeRestart;
  }

  const client = () => createRecurringReminderClient({
    baseUrl: env.MANEKI_REMINDER_URL, tokenFile: env.MANEKI_REMINDER_RECURRING_TOKEN_FILE,
  });
  const byId = (left, right) => left.id.localeCompare(right.id);

  function runHost(config) {
    writeProfile(env.DSH_HOME, [{ id: "probe", name: probe, config: { dshCli, ...config } }]);
    return exerciseHost(cwd, env, patch, undefined, deadline);
  }

  try {
    await restartAt(start);
    const { version: settingsVersion, persona, cloudEnabled, chat } = runtime.assistant.settings();
    const { apiKeyConfigured: _configured, ...chatInput } = chat;
    assert.equal(runtime.assistant.updateSettings({ version: settingsVersion, persona, cloudEnabled, chat: chatInput, timeZone }).timeZone,
      timeZone);
    env.MANEKI_REMINDER_RECURRING_TOKEN_FILE = (await runNode(
      join(repo, "packages/runtime/scripts/pair-reminder-recurring-client.mjs"),
      configDir, String(runtime.port), "dsh-fixture", "--allow-reminder-recurring",
    )).stdout.trim();
    env.MANEKI_REMINDER_WEEKLY_BRIDGE = join(repo, "packages/cli/dist/reminder-weekly-mcp.js");

    // 每日九点的对照提醒验证跳过日和取消后仍有同一时刻的投递。
    const controlMessage = "每日对照";
    const daily = await client().createDailyReminder({ requestId: "daily-control", localTime: "09:00", message: controlMessage }, deadline);
    assert.equal(daily.nextAt, at(22));
    const created = await runHost({});
    const { seriesId } = created.receipt;
    assert.deepEqual(created.receipt, {
      requestId: created.input.requestId, seriesId, localTime: "09:00", timeZone, daysOfWeek: [1, 3, 5], nextAt: at(23),
    });
    assert.deepEqual(deliveries, []);

    async function expectNext(day) {
      assert.deepEqual((await client().listWeeklyReminders(deadline)).reminders, [{
        seriesId, localTime: "09:00", timeZone, message: "休息", daysOfWeek: [1, 3, 5], nextAt: at(day),
      }]);
    }

    async function verifySlot(day, { weekly, daily: dailyControl, label }) {
      const now = at(day);
      const date = `2026-11-${day}`;
      const deliveryStart = deliveries.length;
      const expected = [];
      const notification = (id, message) => ({
        id: `${id}:${date}`, title: "小招提醒",
        body: `${message}（原定 ${new Date(now).toLocaleString("zh-CN", { timeZone })}）`, now,
      });
      if (weekly) expected.push(notification(seriesId, "休息"));
      if (dailyControl) expected.push(notification(daily.seriesId, controlMessage));
      const scansBeforeRestart = await restartAt(now);
      await waitFor(() => completedScans > scansBeforeRestart, `${date} ${label} 未完成调度扫描`, deadline);
      assert.deepEqual(deliveries.slice(deliveryStart).sort(byId), expected.sort(byId), `${date} ${label}`);
      expectedDeliveries.push(...expected);
      slots.push({ date, label, weeklyCalls: Number(weekly), dailyCalls: Number(dailyControl) });
    }

    await verifySlot(23, { weekly: true, daily: true, label: "周一" });
    await expectNext(25);
    await verifySlot(23, { weekly: false, daily: false, label: "周一同一时刻重启" });
    await expectNext(25);
    await verifySlot(24, { weekly: false, daily: true, label: "周二" });
    await expectNext(25);
    await verifySlot(25, { weekly: true, daily: true, label: "周三" });
    await expectNext(27);
    await verifySlot(26, { weekly: false, daily: true, label: "周四" });
    await expectNext(27);
    await verifySlot(27, { weekly: true, daily: true, label: "周五" });
    await expectNext(30);
    await verifySlot(28, { weekly: false, daily: true, label: "周六" });
    await expectNext(30);
    await verifySlot(29, { weekly: false, daily: true, label: "周日" });
    await expectNext(30);
    const cancelled = await runHost({ previous: created });
    await verifySlot(30, { weekly: false, daily: true, label: "取消后的周一" });
    assert.deepEqual((await client().listWeeklyReminders(deadline)).reminders, []);

    await runtime.stop();
    assert.deepEqual(deliveries.sort(byId), expectedDeliveries.sort(byId));
    assert.equal(new Set(deliveries.map(item => item.id)).size, deliveries.length);
    return { dsh: version, node: process.version, timeZone, created, cancelled, notifier: "fixture", slots };
  } finally {
    try { await runtime?.stop(); } finally {
      scanProbe.mock.restore();
      mock.timers.reset();
    }
  }
});
console.log(JSON.stringify(summary, null, 2));
