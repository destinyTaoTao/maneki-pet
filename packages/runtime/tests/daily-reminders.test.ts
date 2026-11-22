import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DailyQuotaPolicy, type SystemNotifier } from "@maneki-pet/core";
import { afterEach, expect, it, vi } from "vitest";
import { AssistantService } from "../src/assistant-service.js";
import { defaultAssistantSettings } from "../src/assistant-settings.js";
import { EventFeed } from "../src/events.js";
import { NotificationBudget } from "../src/quota.js";
import { RuntimeStore } from "../src/store.js";

const dayMs = 86_400_000;
const stateKey = "dailyReminders.v1";
const weekdayStateKey = "weekdayReminders.v1";
const weeklyStateKey = "weeklyReminders.v1";
const versionsKey = "dailyReminderVersions.v1";
const weekdayVersionsKey = "weekdayReminderVersions.v1";
const weeklyVersionsKey = "weeklyReminderVersions.v1";
const dailyInput = { requestId: "create", localTime: "08:00", message: "复查备份" };
const resources: Array<{ assistant: AssistantService; runtime: RuntimeStore }> = [];
const directories: string[] = [];

afterEach(async () => {
  for (const { assistant, runtime } of resources.splice(0)) {
    await assistant.stop();
    runtime.close();
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function start(
  dbPath = ":memory:",
  notify = vi.fn<SystemNotifier["notify"]>().mockResolvedValue({ status: "accepted" }),
  notifications = new NotificationBudget(100),
) {
  const runtime = new RuntimeStore(dbPath);
  const store = runtime.assistantStore();
  const policy = { dnd: false, clientActive: true };
  const feed = new EventFeed();
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  feed.subscribe((event) => events.push(event));
  const assistant = new AssistantService({
    configDir: tmpdir(), store, feed, notifications, notifier: { notify },
    quota: new DailyQuotaPolicy(
      { proactiveDailyTokenLimit: 0, interactiveDailyTokenLimit: null },
      runtime.asQuotaLedger(),
      () => new Date(),
    ),
    dnd: () => policy.dnd, active: () => policy.clientActive, now: Date.now,
  });
  resources.push({ assistant, runtime });
  return {
    assistant, store, notify, policy, events,
    setZone: (timeZone: string) => store.set("settings", JSON.stringify({ ...defaultAssistantSettings(), timeZone })),
    async close() {
      await assistant.stop();
      runtime.close();
      resources.splice(resources.findIndex((item) => item.assistant === assistant), 1);
    },
  };
}

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "maneki-daily-reminder-"));
  directories.push(directory);
  return join(directory, "runtime.sqlite");
}

function setTime(at: string | number) {
  vi.setSystemTime(new Date(at));
}

async function wake(assistant: AssistantService, at?: string | number) {
  if (at !== undefined) setTime(at);
  assistant.wake();
  await vi.advanceTimersByTimeAsync(10);
}

it("时区固定、首次必须严格在未来，查询仅返回该身份的规则并按时间和 ID 排序", () => {
  vi.useFakeTimers();
  setTime("2026-11-21T00:00:00Z");
  const { assistant, setZone } = start();
  setZone("Asia/Shanghai");
  const exact = assistant.createDailyReminder("one", dailyInput);
  expect(exact.nextAt).toBe(Date.parse("2026-11-22T00:00:00Z"));
  const first = assistant.createDailyReminder("one", { ...dailyInput, requestId: "first", localTime: "08:01" });
  const second = assistant.createDailyReminder("one", { ...dailyInput, requestId: "second", localTime: "08:01" });
  setZone("America/Los_Angeles");
  const other = assistant.createDailyReminder("two", dailyInput);
  expect(other).toMatchObject({ timeZone: "America/Los_Angeles", nextAt: Date.parse("2026-11-21T16:00:00Z") });
  const sameTime = [first.seriesId, second.seriesId].sort();
  expect(assistant.listDailyReminders("one").reminders.map((item) => item.seriesId))
    .toEqual([...sameTime, exact.seriesId]);
  expect(assistant.listDailyReminders("one").reminders.every((item) => item.timeZone === "Asia/Shanghai")).toBe(true);
  expect(assistant.listDailyReminders("two").reminders).toHaveLength(1);
  expect(assistant.createDailyReminder("one", dailyInput)).toEqual(exact);
});

it.each([
  { event: "跳过缺失分钟", from: "2026-03-07T07:30:00Z", time: "02:30", next: "2026-03-09T06:30:00Z" },
  { event: "跳过重复分钟", from: "2026-10-31T05:30:00Z", time: "01:30", next: "2026-11-02T06:30:00Z" },
])("$event", async ({ from, time, next }) => {
  vi.useFakeTimers();
  const firstAt = Date.parse(from);
  setTime(firstAt - 1);
  const { assistant, setZone, notify } = start();
  setZone("America/New_York");
  const receipt = assistant.createDailyReminder("one", { ...dailyInput, localTime: time });
  expect(receipt.nextAt).toBe(firstAt);
  await wake(assistant, firstAt);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(assistant.listDailyReminders("one").reminders[0]?.nextAt).toBe(Date.parse(next));
  await wake(assistant, firstAt + dayMs);
  expect(notify).toHaveBeenCalledTimes(1);
  await wake(assistant, next);
  expect(notify).toHaveBeenCalledTimes(2);
});

it("跨 UTC 日期的本地同一天可补投，勿扰跨本地日只考虑当日，回拨不重复已认领日期", async () => {
  vi.useFakeTimers();
  setTime("2026-11-20T23:00:00-08:00");
  const { assistant, setZone, notify, policy } = start();
  setZone("America/Los_Angeles");
  const receipt = assistant.createDailyReminder("one", { ...dailyInput, localTime: "12:00" });
  policy.dnd = true;
  await wake(assistant, "2026-11-21T13:00:00-08:00");
  expect(notify).not.toHaveBeenCalled();
  policy.dnd = false;
  await wake(assistant, "2026-11-21T23:00:00-08:00");
  expect(notify.mock.calls[0]?.[0].id).toBe(`${receipt.seriesId}:2026-11-21`);
  await wake(assistant, "2026-11-21T13:00:00-08:00");
  expect(notify).toHaveBeenCalledTimes(1);
  policy.dnd = true;
  await wake(assistant, "2026-11-23T10:00:00-08:00");
  expect(assistant.listDailyReminders("one").reminders[0]?.nextAt).toBe(Date.parse("2026-11-23T12:00:00-08:00"));
  policy.dnd = false;
  await wake(assistant, "2026-11-22T13:00:00-08:00");
  expect(notify).toHaveBeenCalledTimes(1);
  await wake(assistant, "2026-11-23T13:00:00-08:00");
  expect(notify).toHaveBeenCalledTimes(2);
  expect(notify.mock.calls[1]?.[0].id).toBe(`${receipt.seriesId}:2026-11-23`);
});

it("通知调用在途时重开持久库，次日继续调度且当次不会再次认领", async () => {
  vi.useFakeTimers();
  setTime("2026-11-21T07:00:00Z");
  const db = temporaryDatabase();
  let finish!: (value: Awaited<ReturnType<SystemNotifier["notify"]>>) => void;
  const pending = new Promise<Awaited<ReturnType<SystemNotifier["notify"]>>>((resolve) => { finish = resolve; });
  const notify = vi.fn<SystemNotifier["notify"]>()
    .mockReturnValueOnce(pending)
    .mockResolvedValue({ status: "accepted" });
  const before = start(db, notify);
  before.setZone("UTC");
  const receipt = before.assistant.createDailyReminder("one", dailyInput);
  try {
    await wake(before.assistant, receipt.nextAt);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(before.events.filter((event) => event.kind === "assistant.reminder")).toHaveLength(0);
    // SQLite 已提交认领。使用新连接和 Runtime 对象检查原进程未记录结果时的恢复位置。
    const after = start(db, notify);
    await wake(after.assistant);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(after.assistant.createDailyReminder("one", dailyInput)).toEqual(receipt);
    expect(after.assistant.listDailyReminders("one").reminders[0]?.nextAt).toBe(receipt.nextAt + dayMs);
    await wake(after.assistant, receipt.nextAt + dayMs);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]?.[0].id).toBe(`${receipt.seriesId}:2026-11-22`);
  } finally {
    finish({ status: "accepted" });
  }
});

it("更新时区偏移后从持久日期重新计算，保持已认领日期和旧创建回执", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  setTime("2026-11-21T07:00:00Z");
  const db = temporaryDatabase();
  const before = start(db);
  before.setZone("Etc/UTC");
  const receipt = before.assistant.createDailyReminder("one", dailyInput);
  expect(receipt.nextAt).toBe(Date.parse("2026-11-21T08:00:00Z"));
  await wake(before.assistant, receipt.nextAt);
  expect(before.notify).toHaveBeenCalledTimes(1);
  const stored = JSON.parse(before.store.get(stateKey)!);
  expect(stored.rules[0].nextDate).toBe("2026-11-22");
  await before.close();

  // 模拟重启后 ICU 为同一个时区采用新的 UTC 偏移。
  const formatToParts = Intl.DateTimeFormat.prototype.formatToParts;
  vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockImplementation(function (this: Intl.DateTimeFormat, date) {
    const time = typeof date === "number" && this.resolvedOptions().timeZone === "UTC" ? date + 3_600_000 : date;
    return formatToParts.call(this, time);
  });
  const after = start(db);
  const reprojected = Date.parse("2026-11-22T07:00:00Z");
  expect(after.assistant.listDailyReminders("one").reminders[0]?.nextAt).toBe(reprojected);
  expect(after.assistant.createDailyReminder("one", dailyInput)).toEqual(receipt);
  expect(stored.rules[0]).not.toHaveProperty("nextAt");
  await wake(after.assistant);
  expect(after.notify).not.toHaveBeenCalled();
  await wake(after.assistant, reprojected);
  expect(after.notify).toHaveBeenCalledTimes(1);
  expect(after.notify.mock.calls[0]?.[0].id).toBe(`${receipt.seriesId}:2026-11-22`);
  const afterClaim = after.assistant.listDailyReminders("one");
  const failedWrite = vi.spyOn(after.store, "rememberMutation").mockImplementationOnce(() => {
    throw new Error("fixture cancellation receipt write error");
  });
  const cancel = { requestId: "cancel", seriesId: receipt.seriesId };
  expect(() => after.assistant.cancelDailyReminder("one", cancel)).toThrow("fixture cancellation receipt write error");
  failedWrite.mockRestore();
  expect(after.assistant.listDailyReminders("one")).toEqual(afterClaim);
  expect(after.assistant.cancelDailyReminder("one", cancel).cancelled).toBe(true);
  expect(after.assistant.createDailyReminder("one", dailyInput)).toEqual(receipt);
  expect(after.assistant.listDailyReminders("one").reminders).toHaveLength(0);
});

it("取消与认领串行，旧回执与撤销身份均不能复活规则", async () => {
  vi.useFakeTimers();
  setTime("2026-11-21T07:00:00Z");
  const db = temporaryDatabase();
  const { assistant, setZone, notify, policy, close } = start(db);
  setZone("UTC");
  const receipt = assistant.createDailyReminder("one", dailyInput);
  const pendingInput = { ...dailyInput, requestId: "pending", localTime: "09:00" };
  const pending = assistant.createDailyReminder("one", pendingInput);
  const cancelBeforeClaim = { requestId: "pre-cancel", seriesId: pending.seriesId };
  const cancelledBeforeClaim = assistant.cancelDailyReminder("one", cancelBeforeClaim);
  const cancelInput = { requestId: "cancel", seriesId: receipt.seriesId };
  expect(() => assistant.cancelDailyReminder("two", cancelInput)).toThrow(expect.objectContaining({ status: 404 }));
  expect(() => assistant.cancelDailyReminder("one", { ...cancelInput, requestId: dailyInput.requestId }))
    .toThrow(expect.objectContaining({ status: 409 }));
  policy.clientActive = false;
  let finish!: (value: Awaited<ReturnType<SystemNotifier["notify"]>>) => void;
  notify.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  try {
    await wake(assistant, receipt.nextAt);
    expect(notify).toHaveBeenCalledTimes(1);
    const cancelled = assistant.cancelDailyReminder("one", cancelInput);
    expect(cancelled.cancelled).toBe(true);
    expect(assistant.cancelDailyReminder("one", cancelInput)).toEqual(cancelled);
    expect(() => assistant.cancelDailyReminder("one", { ...cancelInput, seriesId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }))
      .toThrow(expect.objectContaining({ status: 409 }));
    expect(assistant.createDailyReminder("one", dailyInput)).toEqual(receipt);
    expect(assistant.listDailyReminders("one")).toEqual({ reminders: [] });
    expect(() => assistant.createDailyReminder("one", { ...dailyInput, message: "新文案" }))
      .toThrow(expect.objectContaining({ status: 409 }));
  } finally {
    finish?.({ status: "accepted" });
  }
  await close();
  const restarted = start(db, notify);
  expect(restarted.assistant.cancelDailyReminder("one", cancelBeforeClaim)).toEqual(cancelledBeforeClaim);
  expect(restarted.assistant.createDailyReminder("one", pendingInput)).toEqual(pending);
  await wake(restarted.assistant, pending.nextAt);
  expect(notify).toHaveBeenCalledTimes(1);
  await wake(restarted.assistant, receipt.nextAt + 7 * dayMs);
  expect(notify).toHaveBeenCalledTimes(1);
});

it("每日状态损坏时拒绝每日操作，单次照常且通知预算共用", async () => {
  vi.useFakeTimers();
  setTime("2026-11-21T07:59:00Z");
  const { assistant, store, notify, setZone } = start(":memory:", undefined, new NotificationBudget(1));
  setZone("UTC");
  const receipt = assistant.createDailyReminder("one", dailyInput);
  assistant.createAgentReminder("one", { requestId: dailyInput.requestId, afterSeconds: 60, message: "单次" });
  await wake(assistant, receipt.nextAt);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0]?.[0].body).toContain("单次");
  expect(assistant.listDailyReminders("one").reminders[0]?.nextAt).toBe(receipt.nextAt);
  await wake(assistant, receipt.nextAt + 3_600_001);
  expect(notify).toHaveBeenCalledTimes(2);
  expect(notify.mock.calls[1]?.[0].body).toContain(dailyInput.message);
  const invalid = JSON.parse(store.get(stateKey)!);
  invalid.rules[0].nextDate = "2026-11-31";
  store.set(stateKey, JSON.stringify(invalid));
  expect(() => assistant.listDailyReminders("one")).toThrow(expect.objectContaining({ status: 503 }));
  expect(() => assistant.createDailyReminder("one", dailyInput)).toThrow(expect.objectContaining({ status: 503 }));
  expect(() => assistant.cancelDailyReminder("one", { requestId: "cancel", seriesId: receipt.seriesId }))
    .toThrow(expect.objectContaining({ status: 503 }));
  assistant.createAgentReminder("one", { requestId: "still-works", afterSeconds: 1, message: "单次仍可投递" });
  await wake(assistant, receipt.nextAt + 7_200_010);
  expect(notify).toHaveBeenCalledTimes(3);
  expect(notify.mock.calls[2]?.[0].body).toContain("单次仍可投递");
});

it("认领写入失败时从每日调度退避，期间单次仍能投递并在恢复后领到每日当次", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  setTime("2026-11-21T07:59:00Z");
  const { assistant, store, notify, setZone } = start();
  setZone("UTC");
  const receipt = assistant.createDailyReminder("one", dailyInput);
  const save = store.set.bind(store);
  const writes = vi.spyOn(store, "set").mockImplementation((key, value) => {
    if (key === stateKey) throw new Error("fixture daily claim write error");
    save(key, value);
  });
  await wake(assistant, receipt.nextAt);
  expect(notify).not.toHaveBeenCalled();
  expect(writes.mock.calls.filter(([key]) => key === stateKey)).toHaveLength(1);
  assistant.createAgentReminder("one", { requestId: "still-works", afterSeconds: 1, message: "单次仍可投递" });
  await vi.advanceTimersByTimeAsync(1005);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0]?.[0].body).toContain("单次仍可投递");
  expect(writes.mock.calls.filter(([key]) => key === stateKey)).toHaveLength(1);
  writes.mockRestore();
  await vi.advanceTimersByTimeAsync(30_010);
  expect(notify).toHaveBeenCalledTimes(2);
  expect(notify.mock.calls[1]?.[0].body).toContain(dailyInput.message);
});

it.each(["每日", "工作日"])("%s每身份限 8 条、全局限 64 条，取消后还可创建", (kind) => {
  vi.useFakeTimers();
  setTime("2026-11-21T07:00:00Z");
  const { assistant, setZone } = start();
  setZone("UTC");
  const [create, cancel] = kind === "每日"
    ? [assistant.createDailyReminder.bind(assistant), assistant.cancelDailyReminder.bind(assistant)]
    : [assistant.createWeekdayReminder.bind(assistant), assistant.cancelWeekdayReminder.bind(assistant)];
  const first = create("client-0", dailyInput);
  for (let i = 1; i < 64; i++) {
    create(`client-${Math.floor(i / 8)}`, { ...dailyInput, requestId: `create-${i}` });
  }
  expect(() => create("ninth-client", dailyInput)).toThrow(expect.objectContaining({ status: 409 }));
  cancel("client-0", { requestId: "cancel", seriesId: first.seriesId });
  expect(() => create("client-1", dailyInput)).toThrow(expect.objectContaining({ status: 409 }));
  expect(create("ninth-client", dailyInput)).toMatchObject({ requestId: dailyInput.requestId });
});

it("每 UTC 整点小时计 30 次成功创建，拒绝回拨，失败事务与重放不计数", () => {
  vi.useFakeTimers();
  setTime("2026-11-21T07:59:00Z");
  const { assistant, store, setZone } = start();
  setZone("UTC");
  const writeReceipt = vi.spyOn(store, "rememberMutation").mockImplementationOnce(() => {
    throw new Error("fixture receipt write error");
  });
  expect(() => assistant.createDailyReminder("one", dailyInput)).toThrow("fixture receipt write error");
  writeReceipt.mockRestore();
  expect(assistant.listDailyReminders("one")).toEqual({ reminders: [] });
  for (let i = 0; i < 30; i++) {
    const input = { ...dailyInput, requestId: `create-${i}` };
    const receipt = assistant.createDailyReminder("one", input);
    expect(assistant.createDailyReminder("one", input)).toEqual(receipt);
    assistant.cancelDailyReminder("one", { requestId: `cancel-${i}`, seriesId: receipt.seriesId });
  }
  expect(() => assistant.createDailyReminder("one", dailyInput)).toThrow(expect.objectContaining({ status: 429 }));
  setTime("2026-11-21T06:59:59Z");
  expect(() => assistant.createDailyReminder("one", dailyInput)).toThrow(expect.objectContaining({ status: 429 }));
  setTime("2026-11-21T08:00:00Z");
  expect(assistant.createDailyReminder("one", dailyInput)).toMatchObject({ requestId: dailyInput.requestId });
});

it("改期替换旧时刻，旧查询保持原形状，重启及取消后重放首次回执", async () => {
  vi.useFakeTimers();
  setTime("2026-11-21T07:00:00Z");
  const db = temporaryDatabase();
  const before = start(db);
  before.setZone("UTC");
  const { assistant } = before;
  const original = assistant.createDailyReminder("one", dailyInput);
  const other = assistant.createDailyReminder("two", dailyInput);
  before.setZone("Asia/Shanghai");

  expect(before.store.get(versionsKey)).toBeNull();
  expect(assistant.listDailyRescheduleTargets("one")).toEqual({ reminders: [{
    seriesId: original.seriesId, message: dailyInput.message, localTime: "08:00", timeZone: "UTC",
    nextAt: original.nextAt, version: 1,
  }] });
  const input = { requestId: dailyInput.requestId, seriesId: original.seriesId, version: 1, localTime: "09:00" };
  expect(() => assistant.rescheduleDailyReminder("mover-two", "two", input))
    .toThrow(expect.objectContaining({ status: 404, code: "daily_reminder_not_found" }));
  expect(() => assistant.rescheduleDailyReminder("mover-one", "one", { ...input, localTime: "08:00" }))
    .toThrow(expect.objectContaining({ status: 409, code: "daily_reminder_time_unchanged" }));
  const moved = assistant.rescheduleDailyReminder("mover-one", "one", input);
  expect(moved).toEqual({
    requestId: input.requestId, seriesId: original.seriesId, localTime: "09:00", timeZone: "UTC",
    nextAt: Date.parse("2026-11-21T09:00:00Z"), version: 2,
  });
  expect(assistant.listDailyReminders("one")).toEqual({ reminders: [{
    seriesId: original.seriesId, message: dailyInput.message, localTime: "09:00", timeZone: "UTC", nextAt: moved.nextAt,
  }] });
  expect(assistant.listDailyRescheduleTargets("two").reminders[0]).toMatchObject({
    seriesId: other.seriesId, localTime: other.localTime, version: 1,
  });
  expect(JSON.parse(before.store.get(stateKey)!).rules[0]).toEqual({
    nextDate: "2026-11-21", seriesId: original.seriesId, clientId: "one",
    localTime: "09:00", message: dailyInput.message, timeZone: "UTC",
  });
  expect(() => assistant.rescheduleDailyReminder("mover-one", "one", { ...input, requestId: "stale" }))
    .toThrow(expect.objectContaining({ status: 409, code: "version_conflict" }));
  expect(() => assistant.rescheduleDailyReminder("mover-one", "one", { ...input, localTime: "10:00" }))
    .toThrow(expect.objectContaining({ status: 409, code: "request_id_conflict" }));
  await before.close();

  const after = start(db);
  const restarted = after.assistant;
  expect(restarted.listDailyRescheduleTargets("one").reminders[0]).toMatchObject({ version: 2, nextAt: moved.nextAt });
  expect(restarted.rescheduleDailyReminder("mover-one", "one", input)).toEqual(moved);
  await wake(restarted, original.nextAt);
  expect(after.notify.mock.calls.map(([notification]) => notification.id)).toEqual([`${other.seriesId}:2026-11-21`]);
  await wake(restarted, moved.nextAt);
  expect(after.notify.mock.calls.map(([notification]) => notification.id)).toEqual([
    `${other.seriesId}:2026-11-21`, `${original.seriesId}:2026-11-21`,
  ]);
  expect(restarted.rescheduleDailyReminder("mover-one", "one", {
    ...input, requestId: "second-move", version: 2, localTime: "10:00",
  })).toMatchObject({ nextAt: Date.parse("2026-11-22T10:00:00Z"), version: 3 });
  restarted.cancelDailyReminder("one", { requestId: "cancel", seriesId: original.seriesId });
  expect(restarted.listDailyRescheduleTargets("one")).toEqual({ reminders: [] });
  expect(restarted.rescheduleDailyReminder("mover-one", "one", input)).toEqual(moved);
  expect(restarted.createDailyReminder("one", dailyInput)).toEqual(original);
  expect(() => restarted.rescheduleDailyReminder("mover-one", "one", { ...input, requestId: "cancelled" }))
    .toThrow(expect.objectContaining({ status: 404, code: "daily_reminder_not_found" }));
  restarted.rescheduleDailyReminder("mover-two", "two", { ...input, seriesId: other.seriesId });
  expect(JSON.parse(after.store.get(versionsKey)!)).toEqual({ version: 1, bySeries: { [other.seriesId]: 2 } });
});

it("通知仍在途时沿用已认领日期的下界，重启和时钟回拨后仍不重复当天", async () => {
  vi.useFakeTimers();
  setTime("2026-11-21T07:00:00Z");
  const db = temporaryDatabase();
  const before = start(db);
  before.setZone("UTC");
  const original = before.assistant.createDailyReminder("one", dailyInput);
  let finish!: (value: Awaited<ReturnType<SystemNotifier["notify"]>>) => void;
  before.notify.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  try {
    await wake(before.assistant, original.nextAt);
    expect(before.notify).toHaveBeenCalledTimes(1);
    expect(before.assistant.rescheduleDailyReminder("mover", "one", {
      requestId: "in-flight", seriesId: original.seriesId, version: 1, localTime: "09:00",
    })).toMatchObject({ version: 2, nextAt: Date.parse("2026-11-22T09:00:00Z") });
  } finally {
    finish?.({ status: "failed" });
  }
  await before.close();

  setTime("2026-11-21T08:00:00Z");
  const after = start(db, before.notify);
  const final = after.assistant.rescheduleDailyReminder("mover", "one", {
    requestId: "after-restart", seriesId: original.seriesId, version: 2, localTime: "10:00",
  });
  expect(final.nextAt).toBe(Date.parse("2026-11-22T10:00:00Z"));
  await wake(after.assistant, "2026-11-21T10:00:00Z");
  expect(after.notify).toHaveBeenCalledTimes(1);
  await wake(after.assistant, final.nextAt);
  expect(after.notify.mock.calls.map(([notification]) => notification.id)).toEqual([
    `${original.seriesId}:2026-11-21`, `${original.seriesId}:2026-11-22`,
  ]);
});

it("旧时刻已过但勿扰期间尚未认领，可改到当天的未来时刻", async () => {
  vi.useFakeTimers();
  setTime("2026-11-21T07:00:00Z");
  const { assistant, notify, policy, setZone } = start();
  setZone("UTC");
  const original = assistant.createDailyReminder("one", dailyInput);
  policy.dnd = true;
  await wake(assistant, original.nextAt);
  expect(notify).not.toHaveBeenCalled();
  const moved = assistant.rescheduleDailyReminder("mover", "one", {
    requestId: "during-dnd", seriesId: original.seriesId, version: 1, localTime: "09:00",
  });
  expect(moved.nextAt).toBe(Date.parse("2026-11-21T09:00:00Z"));
  policy.dnd = false;
  await wake(assistant);
  expect(notify).not.toHaveBeenCalled();
  await wake(assistant, moved.nextAt);
  expect(notify).toHaveBeenCalledTimes(1);
});

it.each([
  { at: "2026-03-08T05:00:00Z", time: "02:30", next: "2026-03-09T06:30:00Z" },
  { at: "2026-11-01T04:00:00Z", time: "01:30", next: "2026-11-02T06:30:00Z" },
  { at: "2026-11-01T08:00:00Z", time: "03:00", next: "2026-11-02T08:00:00Z" },
])("改期跳过夏令时缺失、重复或恰好到点的本地时刻 $at / $time", ({ at, time, next }) => {
  vi.useFakeTimers();
  setTime(at);
  const { assistant, setZone } = start();
  setZone("America/New_York");
  const original = assistant.createDailyReminder("one", { ...dailyInput, localTime: "04:00" });
  const moved = assistant.rescheduleDailyReminder("mover", "one", {
    requestId: "across-dst", seriesId: original.seriesId, version: 1, localTime: time,
  });
  expect(moved.nextAt).toBe(Date.parse(next));
});

it("改期独立按 UTC 小时计数，回执写失败回滚规则、版本和配额", async () => {
  vi.useFakeTimers();
  setTime("2026-11-21T07:59:00Z");
  const db = temporaryDatabase();
  const before = start(db);
  const { assistant, store } = before;
  before.setZone("UTC");
  const original = assistant.createDailyReminder("one", dailyInput);
  const input = { requestId: "move-1", seriesId: original.seriesId, version: 1, localTime: "09:00" };
  const snapshot = assistant.listDailyRescheduleTargets("one");
  const writeReceipt = vi.spyOn(store, "rememberMutation").mockImplementationOnce(() => {
    throw new Error("fixture reschedule receipt write error");
  });
  expect(() => assistant.rescheduleDailyReminder("one", "one", input)).toThrow("fixture reschedule receipt write error");
  writeReceipt.mockRestore();
  expect(assistant.listDailyRescheduleTargets("one")).toEqual(snapshot);
  expect(store.get(versionsKey)).toBeNull();

  const first = assistant.rescheduleDailyReminder("one", "one", input);
  for (let version = 2; version <= 30; version++) {
    const next = { ...input, requestId: `move-${version}`, version, localTime: version % 2 === 0 ? "08:00" : "09:00" };
    const result = assistant.rescheduleDailyReminder("one", "one", next);
    expect(assistant.rescheduleDailyReminder("one", "one", next)).toEqual(result);
  }
  await before.close();

  const after = start(db);
  const move = () => after.assistant.rescheduleDailyReminder("one", "one", { ...input, requestId: "new-hour", version: 31 });
  expect(move).toThrow(expect.objectContaining({ status: 429 }));
  expect(after.assistant.createDailyReminder("one", { ...dailyInput, requestId: "other-series" })).toMatchObject({ localTime: "08:00" });
  setTime("2026-11-21T06:59:59Z");
  expect(move).toThrow(expect.objectContaining({ status: 429 }));
  expect(after.assistant.rescheduleDailyReminder("one", "one", input)).toEqual(first);
  setTime("2026-11-21T08:00:00Z");
  expect(move()).toMatchObject({ version: 32, nextAt: Date.parse("2026-11-21T09:00:00Z") });
});

it("独立版本存储损坏时拒绝新改期，已经提交的回执及原每日调度保持可用", async () => {
  vi.useFakeTimers();
  setTime("2026-11-21T07:00:00Z");
  const { assistant, store, setZone, notify } = start();
  setZone("UTC");
  const original = assistant.createDailyReminder("one", dailyInput);
  const input = { requestId: "move", seriesId: original.seriesId, version: 1, localTime: "09:00" };
  const moved = assistant.rescheduleDailyReminder("mover", "one", input);
  store.set(versionsKey, JSON.stringify({ version: 1, bySeries: { [original.seriesId]: 1 } }));
  expect(() => assistant.listDailyRescheduleTargets("one")).toThrow(expect.objectContaining({ status: 503 }));
  expect(() => assistant.rescheduleDailyReminder("mover", "one", { ...input, requestId: "new" }))
    .toThrow(expect.objectContaining({ status: 503 }));
  expect(assistant.rescheduleDailyReminder("mover", "one", input)).toEqual(moved);
  expect(assistant.listDailyReminders("one").reminders[0]?.nextAt).toBe(moved.nextAt);
  await wake(assistant, moved.nextAt);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(assistant.cancelDailyReminder("one", { requestId: "cancel", seriesId: original.seriesId }).cancelled).toBe(true);
});
it("工作日按规则的上海日期调度，UTC 周四投递上海周五，周末继续等到周一", async () => {
  vi.useFakeTimers();
  const friday = Date.parse("2026-11-19T16:00:00Z");
  const monday = Date.parse("2026-11-22T16:00:00Z");
  setTime(friday - 500);
  const { assistant, setZone, notify } = start();
  setZone("Asia/Shanghai");
  const input = { ...dailyInput, localTime: "00:00" };
  const receipt = assistant.createWeekdayReminder("one", input);
  expect(receipt).toMatchObject({ timeZone: "Asia/Shanghai", nextAt: friday });
  setZone("UTC");
  await vi.advanceTimersByTimeAsync(520);
  expect(notify.mock.calls.map(([item]) => item.id)).toEqual([`${receipt.seriesId}:2026-11-20`]);
  expect(assistant.listWeekdayReminders("one").reminders[0]?.nextAt).toBe(monday);
  await wake(assistant, friday + dayMs);
  await wake(assistant, friday + 2 * dayMs);
  expect(notify).toHaveBeenCalledTimes(1);
  await wake(assistant, monday);
  expect(notify.mock.calls.map(([item]) => item.id)).toEqual([
    `${receipt.seriesId}:2026-11-20`,
    `${receipt.seriesId}:2026-11-23`,
  ]);
});

it.each([
  { when: "旧时刻前", at: "2026-11-20T08:15:00+08:00" },
  { when: "旧时刻已过但未认领", at: "2026-11-20T09:15:00+08:00" },
])("工作日周五$when改期保留当天新时刻，且旧列表与存储形状兼容", async ({ at }) => {
  vi.useFakeTimers();
  setTime("2026-11-20T08:00:00+08:00");
  const { assistant, store, setZone, notify, policy } = start();
  setZone("Asia/Shanghai");
  const original = assistant.createWeekdayReminder("one", { ...dailyInput, localTime: "09:00" });
  const originalSummary = {
    seriesId: original.seriesId, localTime: "09:00", message: dailyInput.message,
    timeZone: "Asia/Shanghai", nextAt: original.nextAt,
  };
  setZone("UTC");
  expect(store.get(weekdayVersionsKey)).toBeNull();
  expect(assistant.listWeekdayRescheduleTargets("one")).toEqual({ reminders: [{ ...originalSummary, version: 1 }] });
  expect(assistant.listWeekdayRescheduleTargets("other")).toEqual({ reminders: [] });
  const input = { requestId: "move", seriesId: original.seriesId, version: 1, localTime: "10:00" };
  policy.dnd = true;
  await wake(assistant, at);
  expect(() => assistant.rescheduleWeekdayReminder("other-mover", "other", input))
    .toThrow(expect.objectContaining({ status: 404, code: "weekday_reminder_not_found" }));
  expect(() => assistant.rescheduleWeekdayReminder("mover", "one", { ...input, localTime: "09:00" }))
    .toThrow(expect.objectContaining({ status: 409, code: "weekday_reminder_time_unchanged" }));
  const moved = assistant.rescheduleWeekdayReminder("mover", "one", input);
  expect(moved).toEqual({
    ...input, timeZone: "Asia/Shanghai", nextAt: Date.parse("2026-11-20T10:00:00+08:00"), version: 2,
  });
  expect(assistant.listWeekdayReminders("one")).toEqual({
    reminders: [{ ...originalSummary, localTime: moved.localTime, nextAt: moved.nextAt }],
  });
  expect(JSON.parse(store.get(weekdayStateKey)!)).toEqual({ version: 1, rules: [{
    nextDate: "2026-11-20", seriesId: original.seriesId, clientId: "one",
    localTime: "10:00", message: dailyInput.message, timeZone: "Asia/Shanghai",
  }] });
  expect(store.get(versionsKey)).toBeNull();
  expect(JSON.parse(store.get(weekdayVersionsKey)!)).toEqual({ version: 1, bySeries: { [original.seriesId]: 2 } });
  expect(() => assistant.rescheduleWeekdayReminder("mover", "one", { ...input, requestId: "stale" }))
    .toThrow(expect.objectContaining({ status: 409, code: "version_conflict" }));

  policy.dnd = false;
  await wake(assistant, Math.max(original.nextAt, Date.now()));
  expect(notify).not.toHaveBeenCalled();
  await wake(assistant, moved.nextAt);
  await wake(assistant, moved.nextAt + dayMs);
  await wake(assistant, moved.nextAt + 2 * dayMs);
  expect(notify.mock.calls.map(([item]) => item.id)).toEqual([`${original.seriesId}:2026-11-20`]);
  expect(assistant.listWeekdayRescheduleTargets("one").reminders[0]).toMatchObject({
    version: 2, nextAt: Date.parse("2026-11-23T10:00:00+08:00"),
  });
});

it("工作日周五已认领时改到周一，重开库和回拨不再安排周五，取消后仍可重放原回执", async () => {
  vi.useFakeTimers();
  setTime("2026-11-20T08:30:00Z");
  const db = temporaryDatabase();
  const before = start(db);
  before.setZone("UTC");
  const original = before.assistant.createWeekdayReminder("one", { ...dailyInput, localTime: "09:00" });
  const input = { requestId: "in-flight", seriesId: original.seriesId, version: 1, localTime: "10:00" };
  let finish: ((value: Awaited<ReturnType<SystemNotifier["notify"]>>) => void) | undefined;
  before.notify.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  try {
    await wake(before.assistant, original.nextAt);
    expect(before.notify.mock.calls.map(([item]) => item.id)).toEqual([`${original.seriesId}:2026-11-20`]);
    const after = start(db, before.notify);
    const moved = after.assistant.rescheduleWeekdayReminder("mover", "one", input);
    expect(moved).toMatchObject({ version: 2, nextAt: Date.parse("2026-11-23T10:00:00Z") });
    await after.close();

    setTime("2026-11-20T09:00:00Z");
    const restarted = start(db, before.notify);
    expect(restarted.assistant.rescheduleWeekdayReminder("mover", "one", input)).toEqual(moved);
    const next = restarted.assistant.rescheduleWeekdayReminder("mover", "one", {
      ...input, requestId: "after-restart", version: 2, localTime: "11:00",
    });
    expect(next).toMatchObject({ version: 3, nextAt: Date.parse("2026-11-23T11:00:00Z") });
    await wake(restarted.assistant, "2026-11-20T11:00:00Z");
    await wake(restarted.assistant, "2026-11-21T11:00:00Z");
    await wake(restarted.assistant, "2026-11-22T11:00:00Z");
    expect(before.notify).toHaveBeenCalledTimes(1);
    restarted.assistant.cancelWeekdayReminder("one", { requestId: "cancel", seriesId: original.seriesId });
    expect(restarted.assistant.listWeekdayRescheduleTargets("one")).toEqual({ reminders: [] });
    expect(restarted.assistant.rescheduleWeekdayReminder("mover", "one", input)).toEqual(moved);
    expect(() => restarted.assistant.rescheduleWeekdayReminder("mover", "one", { ...input, requestId: "cancelled" }))
      .toThrow(expect.objectContaining({ status: 404 }));
    await wake(restarted.assistant, next.nextAt);
    expect(before.notify).toHaveBeenCalledTimes(1);
  } finally {
    finish?.({ status: "failed" });
  }
});

it.each([
  { friday: "2021-03-26", nextAt: "2021-03-28T21:30:00Z" },
  { friday: "2021-10-29", nextAt: "2021-10-31T22:30:00Z" },
])("工作日改期跳过周五 DST 缺失或重复的时刻 $friday", ({ friday, nextAt }) => {
  vi.useFakeTimers();
  setTime(`${friday}T00:00:00+03:00`);
  const { assistant, setZone } = start();
  setZone("Asia/Amman");
  const original = assistant.createWeekdayReminder("one", dailyInput);
  expect(assistant.rescheduleWeekdayReminder("mover", "one", {
    requestId: "dst", seriesId: original.seriesId, version: 1, localTime: "00:30",
  }).nextAt).toBe(Date.parse(nextAt));
});

it("每日和工作日旧版改期回执兼容，三个周期共用请求 ID 及 UTC 小时额度", () => {
  vi.useFakeTimers();
  setTime("2026-11-20T07:59:00Z");
  const { assistant, store, setZone } = start();
  setZone("UTC");
  const daily = assistant.createDailyReminder("one", dailyInput);
  const weekday = assistant.createWeekdayReminder("one", { ...dailyInput, requestId: "weekday" });
  const weekly = assistant.createWeeklyReminder("one", { ...dailyInput, requestId: "weekly", daysOfWeek: [5] });
  const legacyInput = { requestId: "old-move", seriesId: daily.seriesId, version: 1, localTime: "10:00" };
  const oldReceipt = {
    requestId: legacyInput.requestId, seriesId: daily.seriesId, localTime: "10:00", timeZone: "UTC",
    nextAt: Date.parse("2026-11-20T10:00:00Z"), version: 2,
  };
  const oldHash = createHash("sha256").update(JSON.stringify(["one", daily.seriesId, "10:00", 1])).digest("hex");
  store.set(stateKey, JSON.stringify({ version: 1, rules: [{
    nextDate: "2026-11-20", seriesId: daily.seriesId, clientId: "one",
    localTime: oldReceipt.localTime, message: dailyInput.message, timeZone: oldReceipt.timeZone,
  }] }));
  store.set(versionsKey, JSON.stringify({ version: 1, bySeries: { [daily.seriesId]: oldReceipt.version } }));
  store.rememberMutation("daily-reminder-reschedule:mover", legacyInput.requestId, oldHash, oldReceipt);
  store.consumeAgentReminderQuota("daily_reschedule", "mover", Date.now());
  expect(assistant.rescheduleDailyReminder("mover", "one", legacyInput)).toEqual(oldReceipt);
  expect(() => assistant.rescheduleWeekdayReminder("mover", "one", legacyInput))
    .toThrow(expect.objectContaining({ status: 409, code: "request_id_conflict" }));
  expect(() => assistant.rescheduleWeeklyReminder("mover", "one", legacyInput))
    .toThrow(expect.objectContaining({ status: 409, code: "request_id_conflict" }));

  const weekdayMove = { ...legacyInput, requestId: "move-weekday", seriesId: weekday.seriesId };
  const first = assistant.rescheduleWeekdayReminder("mover", "one", weekdayMove);
  const weekdayHash = createHash("sha256").update(JSON.stringify(["weekday", "one", weekday.seriesId, "10:00", 1])).digest("hex");
  expect(store.mutation("daily-reminder-reschedule:mover", weekdayMove.requestId)).toEqual({
    hash: weekdayHash, result: JSON.stringify({ ...oldReceipt, requestId: weekdayMove.requestId, seriesId: weekday.seriesId }),
  });
  expect(() => assistant.rescheduleDailyReminder("mover", "one", weekdayMove))
    .toThrow(expect.objectContaining({ status: 409, code: "request_id_conflict" }));
  expect(() => assistant.rescheduleWeeklyReminder("mover", "one", weekdayMove))
    .toThrow(expect.objectContaining({ status: 409, code: "request_id_conflict" }));

  const weeklyMove = { ...legacyInput, requestId: "move-weekly", seriesId: weekly.seriesId };
  const weeklyReceipt = assistant.rescheduleWeeklyReminder("mover", "one", weeklyMove);
  const weeklyHash = createHash("sha256").update(JSON.stringify(["weekly", "one", weekly.seriesId, "10:00", 1])).digest("hex");
  expect(store.mutation("daily-reminder-reschedule:mover", weeklyMove.requestId)).toEqual({
    hash: weeklyHash, result: JSON.stringify({
      ...oldReceipt, requestId: weeklyMove.requestId, seriesId: weekly.seriesId, daysOfWeek: [5],
    }),
  });
  expect(() => assistant.rescheduleWeekdayReminder("mover", "one", weeklyMove))
    .toThrow(expect.objectContaining({ status: 409, code: "request_id_conflict" }));
  for (let version = 2; version <= 28; version++) {
    assistant.rescheduleWeekdayReminder("mover", "one", {
      ...weekdayMove, requestId: `move-${version}`, version, localTime: version % 2 === 0 ? "09:00" : "10:00",
    });
  }
  const moveDaily = () => assistant.rescheduleDailyReminder("mover", "one", {
    ...legacyInput, requestId: "new-daily", version: 2, localTime: "11:00",
  });
  expect(moveDaily).toThrow(expect.objectContaining({ status: 429 }));
  expect(() => assistant.rescheduleWeeklyReminder("mover", "one", {
    ...weeklyMove, requestId: "over-quota", version: 2, localTime: "11:00",
  })).toThrow(expect.objectContaining({ status: 429 }));
  setTime("2026-11-20T06:59:59Z");
  expect(moveDaily).toThrow(expect.objectContaining({ status: 429 }));
  expect(assistant.rescheduleWeekdayReminder("mover", "one", weekdayMove)).toEqual(first);
  expect(assistant.rescheduleWeeklyReminder("mover", "one", weeklyMove)).toEqual(weeklyReceipt);
  setTime("2026-11-20T08:00:00Z");
  expect(moveDaily()).toMatchObject({ version: 3, nextAt: Date.parse("2026-11-20T11:00:00Z") });
});

it("工作日版本存储损坏时，每日改期、工作日调度及已提交回执仍可用", async () => {
  vi.useFakeTimers();
  setTime("2026-11-20T07:00:00Z");
  const { assistant, store, setZone, notify } = start();
  setZone("UTC");
  const daily = assistant.createDailyReminder("one", dailyInput);
  const weekday = assistant.createWeekdayReminder("one", { ...dailyInput, requestId: "weekday" });
  const input = { requestId: "move-weekday", seriesId: weekday.seriesId, version: 1, localTime: "09:00" };
  const moved = assistant.rescheduleWeekdayReminder("mover", "one", input);
  store.set(weekdayVersionsKey, JSON.stringify({ version: 1, bySeries: { [weekday.seriesId]: 1 } }));
  expect(() => assistant.listWeekdayRescheduleTargets("one"))
    .toThrow(expect.objectContaining({ status: 503, code: "weekday_reminder_storage_unavailable" }));
  expect(() => assistant.rescheduleWeekdayReminder("mover", "one", {
    ...input, requestId: "new", version: 2, localTime: "10:00",
  })).toThrow(expect.objectContaining({ status: 503 }));
  expect(assistant.rescheduleWeekdayReminder("mover", "one", input)).toEqual(moved);
  expect(assistant.rescheduleDailyReminder("mover", "one", {
    ...input, requestId: "move-daily", seriesId: daily.seriesId, localTime: "10:00",
  })).toMatchObject({ version: 2 });
  await wake(assistant, moved.nextAt);
  expect(notify.mock.calls.map(([item]) => item.id)).toEqual([`${weekday.seriesId}:2026-11-20`]);
});

it("工作日恢复跨过周末时跳过周五，仍可补投当前本地周一", async () => {
  vi.useFakeTimers();
  setTime("2026-11-20T07:00:00+08:00");
  const { assistant, setZone, notify, policy } = start();
  setZone("Asia/Shanghai");
  const receipt = assistant.createWeekdayReminder("one", dailyInput);
  expect(receipt.nextAt).toBe(Date.parse("2026-11-20T08:00:00+08:00"));
  policy.dnd = true;
  await wake(assistant, receipt.nextAt);
  policy.dnd = false;
  // 此时 UTC 仍是周五，上海已是周六。
  await wake(assistant, "2026-11-20T16:00:00Z");
  expect(notify).not.toHaveBeenCalled();
  expect(assistant.listWeekdayReminders("one").reminders[0]?.nextAt)
    .toBe(Date.parse("2026-11-23T08:00:00+08:00"));
  await wake(assistant, "2026-11-20T15:00:00Z");
  expect(notify).not.toHaveBeenCalled();
  await wake(assistant, "2026-11-23T20:00:00+08:00");
  expect(notify.mock.calls.map(([item]) => item.id)).toEqual([`${receipt.seriesId}:2026-11-23`]);
});

it.each([
  { friday: "2021-03-26", nextAt: "2021-03-28T21:30:00Z", nextDate: "2021-03-29", event: "缺失分钟" },
  { friday: "2021-10-29", nextAt: "2021-10-31T22:30:00Z", nextDate: "2021-11-01", event: "重复分钟" },
])("工作日跳过周五 DST $event", async ({ friday, nextAt, nextDate }) => {
  vi.useFakeTimers();
  setTime(`${friday}T00:00:00+03:00`);
  const { assistant, setZone, notify } = start();
  setZone("Asia/Amman");
  const receipt = assistant.createWeekdayReminder("one", { ...dailyInput, localTime: "00:30" });
  expect(receipt.nextAt).toBe(Date.parse(nextAt));
  await wake(assistant, `${friday}T03:00:00+03:00`);
  expect(notify).not.toHaveBeenCalled();
  await wake(assistant, nextAt);
  expect(notify.mock.calls.map(([item]) => item.id)).toEqual([`${receipt.seriesId}:${nextDate}`]);
});

it("工作日通知在途时重开数据库，同日不重领，取消持久生效并保留原回执", async () => {
  vi.useFakeTimers();
  setTime("2026-11-20T07:00:00Z");
  const db = temporaryDatabase();
  let finish!: (value: Awaited<ReturnType<SystemNotifier["notify"]>>) => void;
  const pending = new Promise<Awaited<ReturnType<SystemNotifier["notify"]>>>((resolve) => { finish = resolve; });
  const notify = vi.fn<SystemNotifier["notify"]>()
    .mockReturnValueOnce(pending)
    .mockResolvedValue({ status: "accepted" });
  const before = start(db, notify);
  before.setZone("UTC");
  const receipt = before.assistant.createWeekdayReminder("one", dailyInput);
  const cancellation = { requestId: "cancel", seriesId: receipt.seriesId };
  try {
    await wake(before.assistant, receipt.nextAt);
    expect(notify.mock.calls.map(([item]) => item.id)).toEqual([`${receipt.seriesId}:2026-11-20`]);
    const after = start(db, notify);
    await wake(after.assistant);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(after.assistant.listWeekdayReminders("one").reminders[0]?.nextAt)
      .toBe(Date.parse("2026-11-23T08:00:00Z"));
    expect(() => after.assistant.cancelWeekdayReminder("two", cancellation))
      .toThrow(expect.objectContaining({ status: 404 }));
    expect(after.assistant.cancelWeekdayReminder("one", cancellation).cancelled).toBe(true);
    await after.close();
  } finally {
    finish({ status: "accepted" });
  }
  await before.close();
  const restarted = start(db, notify);
  expect(restarted.assistant.cancelWeekdayReminder("one", cancellation).cancelled).toBe(true);
  expect(restarted.assistant.createWeekdayReminder("one", dailyInput)).toEqual(receipt);
  expect(restarted.assistant.listWeekdayReminders("one")).toEqual({ reminders: [] });
  await wake(restarted.assistant, "2026-11-23T08:00:00Z");
  expect(notify).toHaveBeenCalledTimes(1);
});

it("每日与工作日隔离规则和改期目标，同时共享同一身份的已提交请求 ID", () => {
  vi.useFakeTimers();
  setTime("2026-11-20T07:00:00Z");
  const { assistant, store, setZone } = start();
  setZone("UTC");
  const daily = assistant.createDailyReminder("one", dailyInput);
  const oldHash = createHash("sha256").update(JSON.stringify(["create", dailyInput.localTime, dailyInput.message])).digest("hex");
  expect(store.mutation("daily-reminder:one", dailyInput.requestId)?.hash).toBe(oldHash);
  expect(() => assistant.createWeekdayReminder("one", dailyInput)).toThrow(expect.objectContaining({ status: 409 }));
  const weekdayInput = { ...dailyInput, requestId: "weekday" };
  const weekday = assistant.createWeekdayReminder("one", weekdayInput);
  expect(() => assistant.createDailyReminder("one", weekdayInput)).toThrow(expect.objectContaining({ status: 409 }));
  expect(assistant.listWeekdayReminders("two")).toEqual({ reminders: [] });
  expect(assistant.listWeekdayReminders("one").reminders.map((rule) => rule.seriesId)).toEqual([weekday.seriesId]);
  expect(assistant.listDailyRescheduleTargets("one").reminders.map((rule) => rule.seriesId)).toEqual([daily.seriesId]);
  const cancel = { requestId: "cancel", seriesId: weekday.seriesId };
  expect(() => assistant.cancelDailyReminder("one", cancel)).toThrow(expect.objectContaining({ status: 404 }));
  expect(() => assistant.rescheduleDailyReminder("rescheduler", "one", { ...cancel, version: 1, localTime: "09:00" }))
    .toThrow(expect.objectContaining({ status: 404 }));
  expect(assistant.cancelWeekdayReminder("one", cancel).cancelled).toBe(true);
  expect(() => assistant.cancelDailyReminder("one", cancel)).toThrow(expect.objectContaining({ status: 409 }));
});

it("工作日与每日共用每小时创建额度，各自有活跃上限", () => {
  vi.useFakeTimers();
  setTime("2026-11-20T07:59:00Z");
  const { assistant, setZone } = start();
  setZone("UTC");
  for (let i = 0; i < 22; i++) {
    const { seriesId } = assistant.createDailyReminder("one", { ...dailyInput, requestId: `daily-${i}` });
    assistant.cancelDailyReminder("one", { requestId: `cancel-${i}`, seriesId });
  }
  for (let i = 0; i < 8; i++) {
    assistant.createWeekdayReminder("one", { ...dailyInput, requestId: `weekday-${i}` });
  }
  expect(() => assistant.createDailyReminder("one", dailyInput)).toThrow(expect.objectContaining({ status: 429 }));
  setTime("2026-11-20T08:00:00Z");
  expect(assistant.createDailyReminder("one", dailyInput).requestId).toBe(dailyInput.requestId);
  expect(() => assistant.createWeekdayReminder("one", { ...dailyInput, requestId: "over-weekday" }))
    .toThrow(expect.objectContaining({ status: 409 }));
});

it.each([
  { key: stateKey, kind: "每日", survivor: "工作日" },
  { key: weekdayStateKey, kind: "工作日", survivor: "每日" },
])("$kind 规则存储损坏时，$survivor 规则独立调度", async ({ key, kind, survivor }) => {
  vi.useFakeTimers();
  setTime("2026-11-20T07:00:00Z");
  const { assistant, store, setZone, notify } = start();
  setZone("UTC");
  const daily = assistant.createDailyReminder("one", { ...dailyInput, message: "每日" });
  assistant.createWeekdayReminder("one", { ...dailyInput, requestId: "weekday", message: "工作日" });
  store.set(key, JSON.stringify({ version: 2, rules: [] }));
  const list = () => kind === "每日" ? assistant.listDailyReminders("one") : assistant.listWeekdayReminders("one");
  expect(list).toThrow(expect.objectContaining({ status: 503 }));
  await wake(assistant, daily.nextAt);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0]?.[0].body).toContain(survivor);
});

it("每日先送达后，工作日等同一通知预算释放再补投", async () => {
  vi.useFakeTimers();
  setTime("2026-11-20T07:00:00Z");
  const { assistant, setZone, notify } = start(":memory:", undefined, new NotificationBudget(1));
  setZone("UTC");
  const daily = assistant.createDailyReminder("one", dailyInput);
  const weekday = assistant.createWeekdayReminder("one", { ...dailyInput, requestId: "weekday" });
  await wake(assistant, daily.nextAt);
  expect(notify.mock.calls.map(([item]) => item.id)).toEqual([`${daily.seriesId}:2026-11-20`]);
  await wake(assistant, daily.nextAt + 3_600_001);
  expect(notify.mock.calls.map(([item]) => item.id)).toEqual([
    `${daily.seriesId}:2026-11-20`,
    `${weekday.seriesId}:2026-11-20`,
  ]);
});

it("指定星期按规则时区筛选，回执和列表按 ISO 星期升序展示", () => {
  vi.useFakeTimers();
  setTime("2026-11-21T15:59:00Z");
  const { assistant, setZone } = start();
  setZone("Asia/Shanghai");
  const input = { ...dailyInput, localTime: "00:00", daysOfWeek: [7, 2] };
  const sunday = assistant.createWeeklyReminder("one", input);
  const sameTime = assistant.createWeeklyReminder("one", { ...input, requestId: "same" });
  expect(sunday).toEqual({
    requestId: input.requestId, seriesId: sunday.seriesId, localTime: "00:00",
    timeZone: "Asia/Shanghai", nextAt: Date.parse("2026-11-21T16:00:00Z"), daysOfWeek: [2, 7],
  });
  setTime(sunday.nextAt);
  const tuesday = assistant.createWeeklyReminder("one", { ...input, requestId: "exact" });
  expect(tuesday.nextAt).toBe(Date.parse("2026-11-23T16:00:00Z"));
  setZone("America/Los_Angeles");
  const other = assistant.createWeeklyReminder("two", input);
  expect(other.nextAt).toBe(Date.parse("2026-11-22T08:00:00Z"));
  const reminders = assistant.listWeeklyReminders("one").reminders;
  const sameTimeIds = [sunday.seriesId, sameTime.seriesId].sort();
  expect(reminders.map((rule) => rule.seriesId)).toEqual([...sameTimeIds, tuesday.seriesId]);
  expect(reminders).toEqual(reminders.map((rule) => ({
    seriesId: rule.seriesId, localTime: "00:00", message: input.message, timeZone: "Asia/Shanghai",
    nextAt: rule.seriesId === tuesday.seriesId ? tuesday.nextAt : sunday.nextAt, daysOfWeek: [2, 7],
  })));
  expect(assistant.listWeeklyReminders("two").reminders.map((rule) => rule.seriesId)).toEqual([other.seriesId]);
});

it.each([
  {
    event: "缺失分钟", localTime: "02:30", prior: "2026-03-01T07:30:00Z",
    skipped: "2026-03-08T08:00:00Z", next: "2026-03-15T06:30:00Z",
  },
  {
    event: "重复分钟", localTime: "01:30", prior: "2026-10-25T05:30:00Z",
    skipped: "2026-11-01T06:30:00Z", next: "2026-11-08T06:30:00Z",
  },
])("每周只选一天时跳过 DST $event，继续查找下一周", async ({ localTime, prior, skipped, next }) => {
  vi.useFakeTimers();
  const priorAt = Date.parse(prior);
  setTime(priorAt - 1);
  const { assistant, setZone, notify } = start();
  setZone("America/New_York");
  const input = { ...dailyInput, localTime, daysOfWeek: [7] };
  const ongoing = assistant.createWeeklyReminder("one", input);
  expect(ongoing.nextAt).toBe(priorAt);
  setTime(priorAt);
  const createdOnBoundary = assistant.createWeeklyReminder("two", input);
  expect(createdOnBoundary.nextAt).toBe(Date.parse(next));
  await wake(assistant);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(assistant.listWeeklyReminders("one").reminders[0]?.nextAt).toBe(Date.parse(next));
  await wake(assistant, skipped);
  expect(notify).toHaveBeenCalledTimes(1);
  await wake(assistant, next);
  expect(notify).toHaveBeenCalledTimes(3);
});

it("每周提醒重启后按本地日期补投，认领后回拨不重投，取消和创建回执可重放", async () => {
  vi.useFakeTimers();
  setTime("2026-11-21T23:00:00-08:00");
  const db = temporaryDatabase();
  const before = start(db);
  before.setZone("America/Los_Angeles");
  const input = { ...dailyInput, daysOfWeek: [7, 1] };
  const receipt = before.assistant.createWeeklyReminder("owner", input);
  expect(receipt.nextAt).toBe(Date.parse("2026-11-22T08:00:00-08:00"));
  await before.close();

  const late = "2026-11-22T23:30:00-08:00";
  setTime(late);
  const resumed = start(db, before.notify);
  await wake(resumed.assistant);
  expect(resumed.notify.mock.calls.map(([item]) => item.id)).toEqual([`${receipt.seriesId}:2026-11-22`]);
  expect(JSON.parse(resumed.store.get(weeklyStateKey)!)).toEqual({ version: 1, rules: [{
    nextDate: "2026-11-23", seriesId: receipt.seriesId, clientId: "owner",
    localTime: input.localTime, message: input.message, timeZone: "America/Los_Angeles", daysOfWeek: [1, 7],
  }] });
  expect(resumed.store.get(stateKey)).toBeNull();
  expect(resumed.store.get(weekdayStateKey)).toBeNull();
  await resumed.close();

  setTime(receipt.nextAt);
  const restarted = start(db, before.notify);
  await wake(restarted.assistant);
  await wake(restarted.assistant, "2026-11-22T08:59:00-08:00");
  expect(restarted.notify).toHaveBeenCalledTimes(1);
  const cancel = { requestId: "cancel", seriesId: receipt.seriesId };
  expect(() => restarted.assistant.cancelWeeklyReminder("another", cancel))
    .toThrow(expect.objectContaining({ status: 404, code: "weekly_reminder_not_found" }));
  const cancelled = restarted.assistant.cancelWeeklyReminder("owner", cancel);
  expect(cancelled).toEqual({ ...cancel, cancelled: true });
  await restarted.close();

  const afterCancel = start(db, before.notify);
  expect(afterCancel.assistant.cancelWeeklyReminder("owner", cancel)).toEqual(cancelled);
  expect(afterCancel.assistant.createWeeklyReminder("owner", { ...input, daysOfWeek: [1, 7] })).toEqual(receipt);
  expect(afterCancel.assistant.listWeeklyReminders("owner")).toEqual({ reminders: [] });
  await wake(afterCancel.assistant, "2026-11-23T08:00:00-08:00");
  expect(afterCancel.notify).toHaveBeenCalledTimes(1);
});

it("勿扰跨过入选日期后只保留下一个入选日，解除勿扰前取消可阻止该日认领", async () => {
  vi.useFakeTimers();
  setTime("2026-11-20T07:00:00Z");
  const { assistant, setZone, notify, policy } = start();
  setZone("UTC");
  const receipt = assistant.createWeeklyReminder("one", { ...dailyInput, daysOfWeek: [5, 7] });
  policy.dnd = true;
  await wake(assistant, receipt.nextAt);
  expect(notify).not.toHaveBeenCalled();

  await wake(assistant, "2026-11-21T08:00:00Z");
  expect(assistant.listWeeklyReminders("one").reminders[0]?.nextAt).toBe(Date.parse("2026-11-22T08:00:00Z"));
  await wake(assistant, "2026-11-22T08:00:00Z");
  expect(notify).not.toHaveBeenCalled();
  expect(assistant.cancelWeeklyReminder("one", { requestId: "cancel", seriesId: receipt.seriesId }).cancelled).toBe(true);
  policy.dnd = false;
  await wake(assistant, "2026-11-22T08:59:00Z");
  expect(notify).not.toHaveBeenCalled();
});

it("每周规则与每日和工作日规则共享已提交请求 ID 与创建预算，并独立限制活跃规则数", () => {
  vi.useFakeTimers();
  setTime("2026-11-20T07:59:00Z");
  const { assistant, setZone } = start();
  setZone("UTC");
  const input = { ...dailyInput, daysOfWeek: [7, 1] };
  expect(() => assistant.createWeeklyReminder("one", { ...input, daysOfWeek: [1, 1] }))
    .toThrow(expect.objectContaining({ status: 400, code: "weekly_reminder_input_invalid" }));
  const receipt = assistant.createWeeklyReminder("one", input);
  expect(assistant.createWeeklyReminder("one", { ...input, daysOfWeek: [1, 7] })).toEqual(receipt);
  expect(() => assistant.createWeeklyReminder("one", { ...input, daysOfWeek: [1] }))
    .toThrow(expect.objectContaining({ status: 409, code: "request_id_conflict" }));
  for (const create of [
    () => assistant.createDailyReminder("one", dailyInput),
    () => assistant.createWeekdayReminder("one", dailyInput),
  ]) {
    expect(create).toThrow(expect.objectContaining({ status: 409, code: "request_id_conflict" }));
  }
  for (let i = 0; i < 22; i++) {
    const { seriesId } = assistant.createDailyReminder("one", { ...dailyInput, requestId: `daily-${i}` });
    assistant.cancelDailyReminder("one", { requestId: `cancel-${i}`, seriesId });
  }
  const weekday = assistant.createWeekdayReminder("one", { ...dailyInput, requestId: "weekday" });
  for (let i = 0; i < 6; i++) {
    assistant.createWeeklyReminder("one", { ...input, requestId: `weekly-${i}` });
  }
  expect(() => assistant.createWeeklyReminder("one", { ...input, requestId: "pending" }))
    .toThrow(expect.objectContaining({ status: 429 }));
  setTime("2026-11-20T08:00:00Z");
  assistant.createWeeklyReminder("one", { ...input, requestId: "pending" });
  expect(() => assistant.createWeeklyReminder("one", { ...input, requestId: "over" }))
    .toThrow(expect.objectContaining({ status: 409, code: "weekly_reminder_limit" }));
  const cancel = { requestId: "cancel-weekly", seriesId: receipt.seriesId };
  assistant.cancelWeeklyReminder("one", cancel);
  expect(() => assistant.cancelWeekdayReminder("one", { ...cancel, seriesId: weekday.seriesId }))
    .toThrow(expect.objectContaining({ status: 409, code: "request_id_conflict" }));
  expect(assistant.listWeekdayReminders("one").reminders[0]?.seriesId).toBe(weekday.seriesId);
});

it("每周规则存储损坏会独立退避，其余周期继续使用同一个调度器", async () => {
  vi.useFakeTimers();
  setTime("2026-11-20T07:00:00Z");
  const { assistant, store, setZone, notify } = start();
  setZone("UTC");
  const daily = assistant.createDailyReminder("one", dailyInput);
  const weekday = assistant.createWeekdayReminder("one", { ...dailyInput, requestId: "weekday" });
  assistant.createWeeklyReminder("one", { ...dailyInput, requestId: "weekly", daysOfWeek: [5] });
  const saved = JSON.parse(store.get(weeklyStateKey)!);
  saved.rules[0].daysOfWeek = [5, 5];
  store.set(weeklyStateKey, JSON.stringify(saved));
  expect(() => assistant.listWeeklyReminders("one"))
    .toThrow(expect.objectContaining({ status: 503, code: "weekly_reminder_storage_unavailable" }));
  await wake(assistant, daily.nextAt);
  expect(notify.mock.calls.map(([item]) => item.id)).toEqual([
    `${daily.seriesId}:2026-11-20`,
    `${weekday.seriesId}:2026-11-20`,
  ]);
});

it("旧指定星期规则以版本 1 列出，同日改期替换原时刻，取消并重启后仍返回原回执", async () => {
  vi.useFakeTimers();
  setTime("2026-11-19T23:00:00Z");
  const db = temporaryDatabase();
  const before = start(db);
  const { assistant, store } = before;
  before.setZone("Asia/Shanghai");
  const original = assistant.createWeeklyReminder("owner", { ...dailyInput, daysOfWeek: [7, 5] });
  const sameMessage = assistant.createWeeklyReminder("owner", { ...dailyInput, requestId: "same-message", daysOfWeek: [1] });
  assistant.createWeeklyReminder("other", { ...dailyInput, daysOfWeek: [1, 7] });
  before.setZone("UTC");

  expect(store.get(weeklyVersionsKey)).toBeNull();
  expect(assistant.listWeeklyRescheduleTargets("owner")).toEqual({ reminders: [
    { seriesId: original.seriesId, message: dailyInput.message, localTime: original.localTime, timeZone: original.timeZone,
      nextAt: original.nextAt, daysOfWeek: [5, 7], version: 1 },
    { seriesId: sameMessage.seriesId, message: dailyInput.message, localTime: sameMessage.localTime, timeZone: sameMessage.timeZone,
      nextAt: sameMessage.nextAt, daysOfWeek: [1], version: 1 },
  ] });
  const move = { requestId: "move", seriesId: original.seriesId, version: 1, localTime: "09:00" };
  expect(() => assistant.rescheduleWeeklyReminder("mover", "owner", { ...move, daysOfWeek: [1] }))
    .toThrow(expect.objectContaining({ status: 400, code: "weekly_reminder_reschedule_input_invalid" }));
  expect(() => assistant.rescheduleWeeklyReminder("other-mover", "other", move))
    .toThrow(expect.objectContaining({ status: 404, code: "weekly_reminder_not_found" }));
  expect(() => assistant.rescheduleWeeklyReminder("mover", "owner", { ...move, localTime: "08:00" }))
    .toThrow(expect.objectContaining({ status: 409, code: "weekly_reminder_time_unchanged" }));
  const receipt = assistant.rescheduleWeeklyReminder("mover", "owner", move);
  const expected = { ...move, timeZone: "Asia/Shanghai", nextAt: Date.parse("2026-11-20T01:00:00Z"), version: 2, daysOfWeek: [5, 7] };
  expect(receipt).toEqual(expected);
  receipt.daysOfWeek.push(1);
  expect(JSON.parse(store.get(weeklyStateKey)!).rules[0]).toEqual({
    nextDate: "2026-11-20", seriesId: original.seriesId, clientId: "owner", localTime: "09:00",
    message: dailyInput.message, timeZone: "Asia/Shanghai", daysOfWeek: [5, 7],
  });
  expect(() => assistant.rescheduleWeeklyReminder("mover", "owner", { ...move, requestId: "stale" }))
    .toThrow(expect.objectContaining({ status: 409, code: "version_conflict" }));
  for (const changed of [{ localTime: "10:00" }, { seriesId: sameMessage.seriesId }, { version: 2 }]) {
    expect(() => assistant.rescheduleWeeklyReminder("mover", "owner", { ...move, ...changed }))
      .toThrow(expect.objectContaining({ status: 409, code: "request_id_conflict" }));
  }
  await before.close();

  const after = start(db);
  expect(after.assistant.listWeeklyRescheduleTargets("owner").reminders[0])
    .toMatchObject({ version: 2, nextAt: expected.nextAt, daysOfWeek: [5, 7] });
  await wake(after.assistant, original.nextAt);
  expect(after.notify).not.toHaveBeenCalled();
  await wake(after.assistant, expected.nextAt);
  expect(after.notify.mock.calls.map(([item]) => item.id)).toEqual([`${original.seriesId}:2026-11-20`]);
  after.assistant.cancelWeeklyReminder("owner", { requestId: "cancel", seriesId: original.seriesId });
  await after.close();

  const cancelled = start(db);
  expect(cancelled.assistant.listWeeklyRescheduleTargets("owner").reminders.map((rule) => rule.seriesId)).toEqual([sameMessage.seriesId]);
  expect(cancelled.assistant.rescheduleWeeklyReminder("mover", "owner", move)).toEqual(expected);
  expect(() => cancelled.assistant.rescheduleWeeklyReminder("mover", "owner", { ...move, requestId: "after-cancel" }))
    .toThrow(expect.objectContaining({ status: 404, code: "weekly_reminder_not_found" }));
  await wake(cancelled.assistant, "2026-11-22T01:00:00Z");
  expect(cancelled.notify.mock.calls.map(([item]) => item.id)).not.toContain(`${original.seriesId}:2026-11-22`);
});

it("同日本地时刻已过但尚未认领可以改期，通知在途时改到下一个指定星期", async () => {
  vi.useFakeTimers();
  setTime("2026-11-20T07:00:00Z");
  const db = temporaryDatabase();
  const before = start(db);
  before.setZone("UTC");
  before.policy.dnd = true;
  const original = before.assistant.createWeeklyReminder("owner", { ...dailyInput, daysOfWeek: [2, 5] });
  await wake(before.assistant, "2026-11-20T08:30:00Z");
  expect(before.notify).not.toHaveBeenCalled();
  const move = { requestId: "move", seriesId: original.seriesId, version: 1, localTime: "09:00" };
  const moved = before.assistant.rescheduleWeeklyReminder("mover", "owner", move);
  expect(moved.nextAt).toBe(Date.parse("2026-11-20T09:00:00Z"));

  let finish: ((value: Awaited<ReturnType<SystemNotifier["notify"]>>) => void) | undefined;
  before.notify.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  try {
    before.policy.dnd = false;
    await wake(before.assistant, moved.nextAt);
    expect(before.notify.mock.calls.map(([item]) => item.id)).toEqual([`${original.seriesId}:2026-11-20`]);
    setTime("2026-11-20T08:50:00Z");
    const after = start(db, before.notify);
    const rescheduled = after.assistant.rescheduleWeeklyReminder("mover", "owner", {
      ...move, requestId: "claimed", localTime: "10:00", version: 2,
    });
    expect(rescheduled).toMatchObject({ nextAt: Date.parse("2026-11-24T10:00:00Z"), version: 3, daysOfWeek: [2, 5] });
    finish?.({ status: "accepted" });
    await before.close();
    await wake(after.assistant, "2026-11-20T10:00:00Z");
    await wake(after.assistant, "2026-11-23T10:00:00Z");
    await wake(after.assistant, "2026-11-24T09:00:00Z");
    expect(before.notify).toHaveBeenCalledTimes(1);
    await wake(after.assistant, rescheduled.nextAt);
    expect(before.notify.mock.calls.map(([item]) => item.id)).toEqual([
      `${original.seriesId}:2026-11-20`, `${original.seriesId}:2026-11-24`,
    ]);
  } finally {
    finish?.({ status: "failed" });
  }
});

it.each([
  { now: "2026-03-01T07:30:00Z", localTime: "02:30", nextAt: "2026-03-15T06:30:00Z" },
  { now: "2026-10-25T05:30:00Z", localTime: "01:30", nextAt: "2026-11-08T06:30:00Z" },
])("单个指定星期改期严格晚于受理时间，跳过 DST 异常日 $now", ({ now, localTime, nextAt }) => {
  vi.useFakeTimers();
  setTime(now);
  const { assistant, setZone } = start();
  setZone("America/New_York");
  const original = assistant.createWeeklyReminder("owner", { ...dailyInput, daysOfWeek: [7] });
  const receipt = assistant.rescheduleWeeklyReminder("mover", "owner", {
    requestId: "dst", seriesId: original.seriesId, version: 1, localTime,
  });
  expect(receipt.nextAt).toBe(Date.parse(nextAt));
});

it("指定星期改期的回执写入失败时回滚，版本存储损坏时原调度和回执继续可用", async () => {
  vi.useFakeTimers();
  setTime("2026-11-20T07:00:00Z");
  const { assistant, store, setZone, notify } = start();
  setZone("UTC");
  const weekly = assistant.createWeeklyReminder("owner", { ...dailyInput, daysOfWeek: [5] });
  const daily = assistant.createDailyReminder("owner", { ...dailyInput, requestId: "daily" });
  const input = { requestId: "weekly", seriesId: weekly.seriesId, version: 1, localTime: "09:00" };
  const snapshot = assistant.listWeeklyRescheduleTargets("owner");
  const writeReceipt = vi.spyOn(store, "rememberMutation").mockImplementationOnce(() => {
    throw new Error("fixture reschedule receipt write error");
  });
  expect(() => assistant.rescheduleWeeklyReminder("mover", "owner", input)).toThrow("fixture reschedule receipt write error");
  writeReceipt.mockRestore();
  expect(store.get(weeklyVersionsKey)).toBeNull();
  expect(store.get("dailyReminderRescheduleQuota.v1.mover")).toBeNull();
  expect(assistant.listWeeklyRescheduleTargets("owner")).toEqual(snapshot);

  const moved = assistant.rescheduleWeeklyReminder("mover", "owner", input);
  store.set(weeklyVersionsKey, JSON.stringify({ version: 1, bySeries: { [weekly.seriesId]: 1 } }));
  expect(() => assistant.listWeeklyRescheduleTargets("owner"))
    .toThrow(expect.objectContaining({ status: 503, code: "weekly_reminder_storage_unavailable" }));
  expect(() => assistant.rescheduleWeeklyReminder("mover", "owner", { ...input, requestId: "new", version: 2, localTime: "10:00" }))
    .toThrow(expect.objectContaining({ status: 503, code: "weekly_reminder_storage_unavailable" }));
  expect(assistant.rescheduleWeeklyReminder("mover", "owner", input)).toEqual(moved);
  expect(assistant.rescheduleDailyReminder("mover", "owner", { ...input, requestId: "daily", seriesId: daily.seriesId, localTime: "10:00" }))
    .toMatchObject({ version: 2 });
  await wake(assistant, moved.nextAt);
  expect(notify.mock.calls.map(([item]) => item.id)).toEqual([`${weekly.seriesId}:2026-11-20`]);
  expect(assistant.cancelWeeklyReminder("owner", { requestId: "cancel", seriesId: weekly.seriesId }).cancelled).toBe(true);
});
