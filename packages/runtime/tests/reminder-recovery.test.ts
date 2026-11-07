import { afterEach, expect, it, vi } from "vitest";
import { RuntimeStore } from "../src/store.js";
import { ReminderScheduler } from "../src/reminder-scheduler.js";
import { NotificationBudget } from "../src/quota.js";
import { EventFeed } from "../src/events.js";
const resources: Array<{
  scheduler: ReminderScheduler;
  runtime: RuntimeStore;
}> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of resources.splice(0)) {
    await item.scheduler.stop();
    item.runtime.close();
  }
  vi.useRealTimers();
});
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-08T01:00:00+08:00"));
  const runtime = new RuntimeStore(":memory:"),
    store = runtime.assistantStore(),
    notify = vi.fn().mockResolvedValue({ status: "accepted" }),
    feed = new EventFeed(),
    events: unknown[] = [];
  feed.subscribe((e) => events.push(e));
  const scheduler = new ReminderScheduler(
    store,
    { notify },
    new NotificationBudget(100),
    () => false,
    feed,
  );
  resources.push({ scheduler, runtime });
  const seed = (id: string, at = Date.now()) =>
    store.saveReminder({
      id,
      todoId: null,
      message: `提醒 ${id}`,
      remindAt: at,
      timeZone: "Asia/Shanghai",
      status: "pending",
      attempts: 0,
      code: null,
      version: 1,
    });
  return { runtime, store, notify, scheduler, events, seed };
}
it("持续存储故障退避 30 秒，wake 洪泛和到期记录不会导致 1ms 空转", async () => {
  const { store, scheduler, notify, seed } = setup();
  seed("one");
  const due = vi.spyOn(store, "due").mockImplementation(() => {
    throw new Error("fixture disk error");
  });
  scheduler.wake();
  await vi.advanceTimersByTimeAsync(1);
  expect(due).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 30; i++) scheduler.wake();
  await vi.advanceTimersByTimeAsync(29000);
  expect(due).toHaveBeenCalledTimes(1);
  expect(notify).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1100);
  expect(due).toHaveBeenCalledTimes(2);
  due.mockRestore();
  await vi.advanceTimersByTimeAsync(30100);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(store.reminder("one")?.status).toBe("accepted");
});
it("发送后记账失败保留 sending，其他已到期项不使失败处理空转，重启复用原批次", async () => {
  const { store, scheduler, notify, seed } = setup();
  seed("one");
  const finish = vi.spyOn(store, "finishDelivery").mockImplementation(() => {
    throw new Error("fixture commit failure");
  });
  scheduler.wake();
  await vi.advanceTimersByTimeAsync(1);
  expect(notify).toHaveBeenCalledTimes(1);
  const batch = store.deliveryId("one");
  expect(store.reminder("one")?.status).toBe("sending");
  seed("two");
  scheduler.wake();
  await vi.advanceTimersByTimeAsync(10000);
  expect(notify).toHaveBeenCalledTimes(1);
  finish.mockRestore();
  await scheduler.stop();
  store.recover();
  const next = new ReminderScheduler(
    store,
    { notify },
    new NotificationBudget(100),
    () => false,
    new EventFeed(),
  );
  try {
    next.wake();
    await vi.advanceTimersByTimeAsync(10);
    expect(notify.mock.calls[1]![0].id).toBe(batch);
    expect(store.reminder("one")).toMatchObject({
      status: "accepted",
      attempts: 2,
    });
    expect(store.reminder("two")?.status).toBe("accepted");
  } finally {
    await next.stop();
  }
});
it("时钟后跳不提前投递、前跳与暂停后最多一次扫描补捞，系统受理后不重复", async () => {
  const { store, scheduler, notify, seed } = setup();
  const due = Date.now() + 10000;
  seed("clock", due);
  scheduler.wake();
  await vi.advanceTimersByTimeAsync(1);
  vi.setSystemTime(Date.now() - 60000);
  await vi.advanceTimersByTimeAsync(12000);
  expect(notify).not.toHaveBeenCalled();
  vi.setSystemTime(due + 3600000);
  await vi.advanceTimersByTimeAsync(30010);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0]![0].body).toContain("原定");
  expect(store.reminder("clock")?.status).toBe("accepted");
  await vi.advanceTimersByTimeAsync(90000);
  expect(notify).toHaveBeenCalledTimes(1);
});
