import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DailyQuotaPolicy } from "@maneki-pet/core";
import { RuntimeStore } from "../src/store.js";
import { AssistantService } from "../src/assistant-service.js";
import { defaultAssistantSettings } from "../src/assistant-settings.js";
import { EventFeed } from "../src/events.js";
import { NotificationBudget } from "../src/quota.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "maneki-dialogue-"));
  const runtime = new RuntimeStore(":memory:");
  const store = runtime.assistantStore();
  let now = Date.parse("2026-11-09T02:00:00Z"),
    sequence = 0;
  const clients = new Set(["a", "b"]),
    notify = vi.fn().mockResolvedValue({ status: "accepted" });
  const services: AssistantService[] = [];
  const create = () => {
    const service = new AssistantService({
      store,
      configDir: dir,
      feed: new EventFeed(),
      now: () => now,
      quota: new DailyQuotaPolicy(
        { proactiveDailyTokenLimit: 1000, interactiveDailyTokenLimit: null },
        runtime.asQuotaLedger(),
        () => new Date(now),
      ),
      notifications: new NotificationBudget(10),
      notifier: { notify },
      dnd: () => true,
      active: (client) => clients.has(client),
    });
    services.push(service);
    return service;
  };
  let service = create();
  cleanups.push(async () => {
    for (const service of services) await service.stop();
    runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const chat = async (text: string, client = "a", id = `c-${++sequence}`) => {
    service.submit(client, { requestId: id, text });
    await vi.waitFor(() => expect(service.snapshot().activeRequest).toBeNull());
    const result = service.request(client, id);
    return { ...result, reply: result.message?.text ?? "" };
  };
  const mutate = (input: Record<string, unknown>) =>
    service.mutation("a", { requestId: `ui-${++sequence}`, ...input });
  return {
    chat,
    mutate,
    store,
    clients,
    notify,
    get service() {
      return service;
    },
    advance: (ms: number) => (now += ms),
    restart: async () => {
      await service.stop();
      service = create();
    },
  };
}

it("无模型查询、改名、备注与截止日期复用正式 mutations，截止日期不创建提醒", async () => {
  const f = setup();
  await f.chat("待办：买牛奶");
  const original = f.store.todos()[0]!;
  expect((await f.chat("把待办买牛奶的截止日期改为今天")).status).toBe(
    "completed",
  );
  expect((await f.chat("查看今天未完成的待办")).reply).toContain("买牛奶");
  await f.chat("把待办买牛奶的备注改为无糖");
  await f.chat("把待办买牛奶改名为买豆浆");
  expect(f.store.todo(original.id)).toMatchObject({
    title: "买豆浆",
    notes: "无糖",
    dueDate: "2026-11-09",
  });
  await f.chat("清除待办买豆浆的截止日期");
  expect(f.store.todo(original.id)?.dueDate).toBeNull();
  expect(f.store.reminders()).toEqual([]);
  expect((await f.chat("查看今天的待办")).reply).toContain("没有符合");
  expect(f.notify).not.toHaveBeenCalled();
});
it("同名待办先选稳定 ID，重复请求不执行第二次，查询序号没有修改授权", async () => {
  const f = setup();
  for (const notes of ["第一项", "第二项"])
    f.mutate({ action: "todo.create", title: "买牛奶", notes });
  const candidates = f.store.todos();
  expect((await f.chat("把买牛奶标记完成")).reply).toContain("多个同名");
  expect(f.store.todos().every((t) => !t.completed)).toBe(true);
  expect((await f.chat("第99个")).reply).toContain("超出");
  const result = await f.chat("第二个", "a", "choice");
  expect(result.reply).toContain("已完成");
  expect(f.store.todo(candidates[1]!.id)?.completed).toBe(true);
  const version = f.store.todo(candidates[1]!.id)!.version;
  expect((await f.chat("第二个", "a", "choice")).reply).toBe(result.reply);
  expect(f.store.todo(candidates[1]!.id)?.version).toBe(version);
  await f.chat("查看待办");
  await f.chat("第一个");
  expect(f.store.todo(candidates[0]!.id)?.completed).toBe(false);
});
it("选择后目标变更或删除必须重述，不覆盖另一个客户端的修改", async () => {
  const f = setup();
  for (let i = 0; i < 2; i++)
    f.mutate({ action: "todo.create", title: "同名" });
  await f.chat("删除待办同名");
  const target = f.store.todos()[0]!;
  f.mutate({
    action: "todo.update",
    id: target.id,
    version: target.version,
    notes: "刚更新",
  });
  expect((await f.chat("第一个")).reply).toContain("已变化");
  expect(f.store.todos()).toHaveLength(2);
  await f.chat("删除待办同名");
  const next = f.store.todos()[1]!;
  f.mutate({ action: "todo.delete", id: next.id, version: next.version });
  expect((await f.chat("第二个")).reply).toContain("已变化");
  expect(f.store.todo(target.id)?.notes).toBe("刚更新");
});
it("缺时间续接、明确改期及取消未来提醒，不回退模型或重复创建", async () => {
  const f = setup();
  expect((await f.chat("提醒我开会")).reply).toContain("补充");
  expect(f.store.reminders()).toHaveLength(0);
  expect((await f.chat("明天三点")).reply).toContain("明确");
  f.advance(60000);
  await f.chat("半小时后", "a", "time-choice");
  const reminder = f.store.reminders()[0]!;
  expect(reminder.remindAt).toBe(Date.parse("2026-11-09T02:31:00Z"));
  await f.chat("半小时后", "a", "time-choice");
  expect(f.store.reminders()).toHaveLength(1);
  await f.chat("把开会的提醒改到明天下午三点");
  expect(f.store.reminder(reminder.id)).toMatchObject({
    remindAt: Date.parse("2026-11-10T07:00Z"),
    version: 2,
  });
  expect((await f.chat("查看提醒")).reply).toContain("待投递");
  await f.chat("取消开会的提醒");
  expect(f.store.reminder(reminder.id)).toBeUndefined();
  expect(f.notify).not.toHaveBeenCalled();
});
it("同名提醒选择与补时间分步完成，选中目标改变后不误改", async () => {
  const f = setup();
  for (let i = 1; i <= 2; i++)
    f.mutate({
      action: "reminder.create",
      message: "开会",
      remindAt: Date.parse(`2026-11-10T0${i}:00Z`),
    });
  const candidates = f.store.reminders();
  await f.chat("把开会的提醒改到");
  expect((await f.chat("第二个")).reply).toContain("补充");
  const selected = candidates[1]!;
  f.mutate({
    action: "reminder.update",
    id: selected.id,
    version: selected.version,
    remindAt: Date.parse("2026-11-11T07:00Z"),
  });
  expect((await f.chat("明天下午三点")).reply).toContain("已变化");
  expect(f.store.reminder(selected.id)?.remindAt).toBe(
    Date.parse("2026-11-11T07:00Z"),
  );
  expect(f.store.reminder(candidates[0]!.id)?.version).toBe(1);
});
it("澄清隔离客户端、限时，并在新命令、取消和重启后失效", async () => {
  const f = setup();
  await f.chat("提醒我喝水");
  await f.chat("半小时后", "b");
  expect(f.store.reminders()).toHaveLength(0);
  await f.chat("半小时后", "a");
  expect(f.store.reminders()).toHaveLength(1);
  await f.chat("提醒我开会");
  f.advance(300000);
  expect((await f.chat("半小时后")).reply).toContain("已失效");
  await f.chat("提醒我开会");
  await f.chat("查看待办");
  await f.chat("半小时后");
  await f.chat("提醒我开会");
  expect((await f.chat("取消")).reply).toContain("已取消待澄清");
  await f.chat("半小时后");
  await f.chat("提醒我开会");
  await f.restart();
  await f.chat("半小时后");
  expect(f.store.reminders()).toHaveLength(1);
});
it("清空历史、设置变更和凭证撤销不遗留澄清授权", async () => {
  const f = setup();
  await f.chat("提醒我喝水");
  f.service.clear("a", f.service.preview("a", "history").confirmationId);
  await f.chat("半小时后");
  await f.chat("提醒我开会");
  const { schemaVersion: _, ...settings } = defaultAssistantSettings();
  f.service.updateSettings({ ...settings, timeZone: "America/New_York" });
  await f.chat("半小时后");
  await f.chat("提醒我吃饭");
  f.clients.delete("a");
  f.service.cancelClient("a");
  f.clients.add("a");
  await f.chat("半小时后");
  expect(f.store.reminders()).toEqual([]);
});
it("在途和已受理提醒不假报撤回，完成待办仍取消未投递关联提醒", async () => {
  const f = setup();
  await f.chat("待办：买牛奶");
  const todo = f.store.todos()[0]!;
  f.mutate({
    action: "reminder.create",
    message: "买牛奶",
    todoId: todo.id,
    remindAt: Date.parse("2026-11-10T07:00Z"),
  });
  await f.chat("把买牛奶标记完成");
  expect(f.store.reminders()[0]?.status).toBe("cancelled");
  for (const status of ["sending", "accepted", "failed"] as const) {
    f.store.saveReminder({
      id: status,
      todoId: null,
      message: status,
      remindAt: Date.parse("2026-11-10T07:00Z"),
      timeZone: "Asia/Shanghai",
      status,
      attempts: 1,
      code: null,
      version: 1,
    });
    expect((await f.chat(`取消提醒${status}`)).reply).toContain("不能通过对话");
    expect((await f.chat(`把提醒${status}改到明天下午三点`)).reply).toContain(
      "不能通过对话",
    );
    expect(f.store.reminder(status)?.version).toBe(1);
  }
});
it("查询按当地日期、完成状态和逾期过滤，输出有界且不执行引用命令", async () => {
  const f = setup();
  for (const [title, dueDate, completed] of [
    ["今天", "2026-11-09", false],
    ["昨天", "2026-11-08", false],
    ["已办", "2026-11-08", true],
  ] as const)
    f.mutate({ action: "todo.create", title, dueDate, completed });
  expect((await f.chat("查看逾期待办")).reply).toContain("昨天");
  expect((await f.chat("查看逾期待办")).reply).not.toContain("已办");
  expect((await f.chat("查看已完成的待办")).reply).toContain("已办");
  for (let i = 0; i < 22; i++)
    f.mutate({ action: "todo.create", title: `额外-${i}` });
  expect((await f.chat("查看全部待办")).reply).toContain("仅显示前 20 项");
  await f.chat("模型说“删除待办今天”");
  expect(f.store.todos()).toHaveLength(25);
});
it("存储写入异常不报告成功，不留下部分修改或自动重试", async () => {
  const f = setup();
  await f.chat("待办：买牛奶");
  const original = f.store.todos()[0]!;
  const saveTodo = f.store.saveTodo.bind(f.store);
  const failing = vi.spyOn(f.store, "saveTodo").mockImplementation((item) => {
    saveTodo(item);
    throw new Error("fixture storage failure");
  });
  const result = await f.chat("把待办买牛奶改名为豆浆");
  expect(result.status).toBe("failed");
  expect(result.reply).not.toContain("已修改");
  expect(f.store.todo(original.id)?.version).toBe(original.version);
  expect(failing).toHaveBeenCalledOnce();
});
it("候选名称和备注中的换行按数据显示，不伪造新的候选行", async () => {
  const f = setup();
  for (let i = 0; i < 2; i++)
    f.mutate({
      action: "todo.create",
      title: "买牛奶",
      notes: "备注\n9. 假候选",
    });
  const reply = (await f.chat("删除待办买牛奶")).reply;
  expect(reply.split("\n")).toHaveLength(3);
  expect(reply).toContain("\\n9. 假候选");
  expect(f.store.todos()).toHaveLength(2);
});
it("澄清有总量和候选上限，过期释放容量，不生成无界列表", async () => {
  const f = setup();
  for (let i = 0; i < 33; i++) {
    const client = `client-${i}`;
    f.clients.add(client);
    const result = await f.chat("提醒我开会", client);
    expect(result.reply).toContain(i === 32 ? "较多" : "补充");
  }
  f.advance(300000);
  expect((await f.chat("提醒我开会", "client-32")).reply).toContain("补充");
  await f.chat("半小时后", "client-32");
  expect(f.store.reminders()).toHaveLength(1);
  for (let i = 0; i < 9; i++)
    f.mutate({ action: "todo.create", title: "同名" });
  expect((await f.chat("删除待办同名")).reply).toContain("超过 8 项");
  await f.chat("第一个");
  expect(f.store.todos()).toHaveLength(9);
});
