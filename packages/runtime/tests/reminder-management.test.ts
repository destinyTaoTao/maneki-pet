import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startRuntime, type StartedRuntime } from "../src/runtime.js";
import { RuntimeStore, MigrationError } from "../src/store.js";
import { AssistantStore } from "../src/assistant-store.js";
const dirs: string[] = [],
  runtimes: StartedRuntime[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of runtimes.splice(0)) await r.stop();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "maneki-reminder-management-"));
  dirs.push(dir);
  return dir;
}
async function setup() {
  const r = await startRuntime({
    configDir: directory(),
    notifier: {
      notify: async () => ({ status: "failed", code: "fixture_refused" }),
    },
  });
  runtimes.push(r);
  const store = r.store.assistantStore();
  store.saveReminder({
    id: "r",
    todoId: null,
    message: "核对结果",
    remindAt: Date.now() - 60000,
    timeZone: "Asia/Shanghai",
    status: "failed",
    attempts: 1,
    code: "fixture_refused",
    version: 3,
  });
  r.store.kvSet("dnd", "1");
  const base = `http://127.0.0.1:${r.port}/v1`;
  async function call(path: string, body?: unknown, token = r.rootToken) {
    const res = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: res.status,
      body: (await res.json()) as Record<string, any>,
    };
  }
  const pair = async (name: string, scopes: string) =>
    (await call("/pair", { name, scopes })).body.token as string;
  return {
    r,
    store,
    call,
    first: await pair("first", "assistant"),
    second: await pair("second", "assistant"),
    observer: await pair("observer", "express"),
  };
}
it("查看确认与系统失败分开，跨客户端幂等/版本冲突，观察凭证不能操作", async () => {
  const { r, store, call, first, second, observer } = await setup();
  const command = {
    requestId: "seen",
    action: "reminder.ack",
    id: "r",
    version: 3,
  };
  expect((await call("/assistant/mutations", command, observer)).status).toBe(
    403,
  );
  const firstResult = await call("/assistant/mutations", command, first);
  expect(firstResult.status).toBe(200);
  expect(firstResult.body.seenAt).toEqual(expect.any(Number));
  expect(await call("/assistant/mutations", command, first)).toEqual(
    firstResult,
  );
  expect((await call("/assistant/mutations", command, second)).status).toBe(
    409,
  );
  const row = store.reminder("r")!;
  expect(row).toMatchObject({
    status: "failed",
    code: "fixture_refused",
    version: 4,
    attempts: 1,
    seenAt: firstResult.body.seenAt,
  });
  expect(
    (await call("/assistant/snapshot", undefined, second)).body.reminders[0]
      .seenAt,
  ).toBe(firstResult.body.seenAt);
  const again = await call(
    "/assistant/mutations",
    { ...command, requestId: "seen-again", version: 4 },
    second,
  );
  expect(again.body.seenAt).toBe(firstResult.body.seenAt);
  expect(store.reminder("r")?.version).toBe(4);
  await r.stop();
  const restarted = await startRuntime({
    configDir: r.store.dbPath.replace(/[\\/]runtime.db$/, ""),
    notifier: { notify: async () => ({ status: "failed" }) },
  });
  runtimes.push(restarted);
  expect(restarted.assistant.snapshot().reminders[0]).toMatchObject({
    status: "failed",
    seenAt: firstResult.body.seenAt,
  });
});
it("重试保留原时间和累计次数、清除旧批次/已查看，勿扰期间不抢投，同请求只办理一次", async () => {
  const { r, store, call, first } = await setup(),
    original = store.reminder("r")!;
  store.acknowledgeReminder("r", Date.now());
  const command = {
    requestId: "retry",
    action: "reminder.retry",
    id: "r",
    version: 4,
  };
  const reply = await call("/assistant/mutations", command, first);
  expect(reply.status).toBe(200);
  expect(await call("/assistant/mutations", command, first)).toEqual(reply);
  expect(store.reminder("r")).toMatchObject({
    status: "pending",
    seenAt: null,
    code: null,
    remindAt: original.remindAt,
    attempts: 1,
    version: 5,
  });
  expect(store.deliveryId("r")).toBeNull();
  expect(
    (
      await call(
        "/assistant/mutations",
        { ...command, requestId: "retry-second", version: 5 },
        first,
      )
    ).body.error,
  ).toBe("reminder_not_failed");
  r.store.kvSet("dnd", "0");
  r.assistant.wake();
  await vi.waitFor(() =>
    expect(store.reminder("r")).toMatchObject({
      status: "failed",
      attempts: 2,
    }),
  );
  expect(store.deliveryId("r")).toEqual(expect.any(String));
});
it("待办完成、投递中、已受理和额外参数拒绝重试，存储失败不留下确认或幂等假成功", async () => {
  const { store, call, first } = await setup();
  const command = {
    requestId: "op",
    action: "reminder.ack",
    id: "r",
    version: 3,
  };
  expect(
    (
      await call(
        "/assistant/mutations",
        { ...command, message: "替换内容" },
        first,
      )
    ).status,
  ).toBe(400);
  const write = vi
    .spyOn(AssistantStore.prototype, "acknowledgeReminder")
    .mockImplementation(() => {
      throw new Error("fixture-storage-error");
    });
  try {
    expect((await call("/assistant/mutations", command, first)).status).toBe(
      500,
    );
    expect(store.reminder("r")).toMatchObject({ seenAt: null, version: 3 });
  } finally {
    write.mockRestore();
  }
  expect((await call("/assistant/mutations", command, first)).status).toBe(200);
  store.saveTodo({
    id: "todo",
    title: "完成了",
    notes: "",
    dueDate: null,
    completed: true,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const linked = { ...store.reminder("r")!, todoId: "todo" };
  store.deleteReminder("r");
  store.saveReminder(linked);
  expect(
    (
      await call(
        "/assistant/mutations",
        {
          requestId: "completed",
          action: "reminder.retry",
          id: "r",
          version: 4,
        },
        first,
      )
    ).body.error,
  ).toBe("todo_unavailable");
  for (const status of [
    "pending",
    "sending",
    "accepted",
    "cancelled",
  ] as const) {
    store.saveReminder({ ...store.reminder("r")!, status });
    expect(
      (
        await call(
          "/assistant/mutations",
          { requestId: status, action: "reminder.retry", id: "r", version: 4 },
          first,
        )
      ).body.error,
    ).toBe("reminder_not_failed");
    if (status !== "accepted")
      expect(
        (
          await call(
            "/assistant/mutations",
            {
              requestId: `seen-${status}`,
              action: "reminder.ack",
              id: "r",
              version: 4,
            },
            first,
          )
        ).body.error,
      ).toBe("reminder_not_delivered");
  }
});
it("两个客户端同时重试只受理一次，等待/在途状态不再新建尝试", async () => {
  const { store, call, first, second } = await setup();
  const command = {
    requestId: "race",
    action: "reminder.retry",
    id: "r",
    version: 3,
  };
  const replies = await Promise.all([
    call("/assistant/mutations", command, first),
    call("/assistant/mutations", command, second),
  ]);
  expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(store.reminder("r")).toMatchObject({
    status: "pending",
    version: 4,
    attempts: 1,
  });
});
it("v5→v6 备份保留提醒批次、会话和云配置；中途失败回滚并拒绝启动", () => {
  const path = join(directory(), "runtime.db"),
    seed = new RuntimeStore(path),
    store = seed.assistantStore();
  store.saveReminder({
    id: "old",
    todoId: null,
    message: "备份",
    remindAt: 1,
    timeZone: "UTC",
    status: "pending",
    attempts: 0,
    code: null,
    version: 1,
  });
  store.claim("old", "stable-delivery");
  store.append("user", "保留对话");
  store.set(
    "settings",
    JSON.stringify({ voice: { asr: { provider: "bailian" } } }),
  );
  seed.close();
  const old = new DatabaseSync(path);
  old.exec(
    "ALTER TABLE assistant_reminders DROP COLUMN seen_at; DELETE FROM schema_migrations WHERE version=6; CREATE TRIGGER migration_failure BEFORE INSERT ON schema_migrations WHEN NEW.version=6 BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  old.close();
  expect(() => new RuntimeStore(path)).toThrow(MigrationError);
  expect(existsSync(`${path}.bak-5`)).toBe(true);
  const failed = new DatabaseSync(path);
  expect(
    failed
      .prepare("PRAGMA table_info(assistant_reminders)")
      .all()
      .some((c) => c.name === "seen_at"),
  ).toBe(false);
  expect(
    failed.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v,
  ).toBe(5);
  failed.exec("DROP TRIGGER migration_failure");
  failed.close();
  const upgraded = new RuntimeStore(path);
  try {
    expect(upgraded.assistantStore().reminder("old")).toMatchObject({
      status: "sending",
      seenAt: null,
      attempts: 1,
    });
    expect(upgraded.assistantStore().deliveryId("old")).toBe("stable-delivery");
    expect(upgraded.assistantStore().messages()[0]?.text).toBe("保留对话");
    expect(upgraded.assistantStore().get("settings")).toContain("bailian");
    const backup = new DatabaseSync(`${path}.bak-5`, { readOnly: true });
    try {
      expect(
        backup.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()
          ?.v,
      ).toBe(5);
      expect(
        backup.prepare("SELECT delivery_id FROM assistant_reminders").get()
          ?.delivery_id,
      ).toBe("stable-delivery");
    } finally {
      backup.close();
    }
  } finally {
    upgraded.close();
  }
});
