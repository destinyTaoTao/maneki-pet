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

it("每身份限 8 条、全局限 64 条，取消后还可创建", () => {
  vi.useFakeTimers();
  setTime("2026-11-21T07:00:00Z");
  const { assistant, setZone } = start();
  setZone("UTC");
  const first = assistant.createDailyReminder("client-0", dailyInput);
  for (let i = 1; i < 64; i++) {
    assistant.createDailyReminder(`client-${Math.floor(i / 8)}`, { ...dailyInput, requestId: `create-${i}` });
  }
  expect(() => assistant.createDailyReminder("ninth-client", dailyInput)).toThrow(expect.objectContaining({ status: 409 }));
  assistant.cancelDailyReminder("client-0", { requestId: "cancel", seriesId: first.seriesId });
  expect(() => assistant.createDailyReminder("client-1", dailyInput)).toThrow(expect.objectContaining({ status: 409 }));
  expect(assistant.createDailyReminder("ninth-client", dailyInput)).toMatchObject({ requestId: dailyInput.requestId });
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
