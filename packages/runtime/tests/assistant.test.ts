import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { startRuntime, type StartedRuntime } from "../src/runtime.js";
import { defaultAssistantSettings } from "../src/assistant-settings.js";
import type { ChatReply } from "@maneki-pet/core";
import { createServer } from "node:http";
const dirs: string[] = [];
const runtimes: StartedRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
async function setup(
  options: Parameters<typeof startRuntime>[0] = { configDir: "" },
) {
  const dir = mkdtempSync(join(tmpdir(), "maneki-assistant-"));
  dirs.push(dir);
  const notifier = vi.fn().mockResolvedValue({ status: "accepted" });
  const runtime = await startRuntime({
    ...options,
    configDir: dir,
    notifier: options.notifier ?? { notify: notifier },
  });
  runtimes.push(runtime);
  const base = `http://127.0.0.1:${runtime.port}`;
  const call = async (
    path: string,
    body?: unknown,
    token = runtime.rootToken,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const paired = await call("/v1/pair", {
    name: "assistant",
    scopes: "assistant,settings",
  });
  return { dir, runtime, call, token: paired.body.token as string, notifier };
}
const prefix = "/v1/assistant";
it("配置的本机兼容端点贯通真实 HTTP Provider，模型文本不能创建待办", async () => {
  const model = createServer((_req, res) =>
    res.end(
      JSON.stringify({
        choices: [
          { message: { content: "待办：这只是回答" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      }),
    ),
  );
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  try {
    const { call, token } = await setup();
    const { schemaVersion: _, ...settings } = defaultAssistantSettings();
    settings.chat = {
      ...settings.chat,
      enabled: true,
      baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
      model: "fixture",
    };
    expect(
      (await call(prefix + "/settings", settings, token, "PUT")).status,
    ).toBe(200);
    await call(
      prefix + "/chat",
      { requestId: "http-model", text: "你好" },
      token,
    );
    await vi.waitFor(async () =>
      expect(
        (await call(prefix + "/chat/http-model", undefined, token)).body.status,
      ).toBe("completed"),
    );
    const snapshot = (await call(prefix + "/snapshot", undefined, token)).body;
    expect(snapshot.messages.at(-1).text).toBe("待办：这只是回答");
    expect(snapshot.todos).toEqual([]);
  } finally {
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
  }
});
it("观察端不能读取或修改个人数据，客户端请求幂等键隔离且更新版本冲突不覆盖", async () => {
  const { call, token } = await setup();
  const observer = await call("/v1/pair", { name: "dsh", scopes: "express" });
  expect(
    (await call(prefix + "/snapshot", undefined, observer.body.token)).status,
  ).toBe(403);
  expect(
    (
      await call(
        prefix + "/chat",
        { requestId: "a", text: "待办：买牛奶" },
        observer.body.token,
      )
    ).status,
  ).toBe(403);
  const create = {
    requestId: "one",
    action: "todo.create",
    title: "周五前提交报销",
  };
  const a = await call(prefix + "/mutations", create, token);
  const again = await call(prefix + "/mutations", create, token);
  expect(again.body).toEqual(a.body);
  expect(
    (await call(prefix + "/mutations", { ...create, title: "不同内容" }, token))
      .status,
  ).toBe(409);
  const second = await call("/v1/pair", {
    name: "second",
    scopes: "assistant",
  });
  expect(
    (await call(prefix + "/mutations", create, second.body.token)).status,
  ).toBe(200);
  const snapshot = (await call(prefix + "/snapshot", undefined, token)).body;
  expect(snapshot.todos).toHaveLength(2);
  expect(snapshot.reminders).toEqual([]);
  const todo = snapshot.todos[0];
  expect(todo.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(
    (
      await call(
        prefix + "/mutations",
        {
          requestId: "update",
          action: "todo.update",
          id: todo.id,
          version: todo.version,
          title: "改名",
        },
        token,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await call(
        prefix + "/mutations",
        {
          requestId: "stale",
          action: "todo.update",
          id: todo.id,
          version: todo.version,
          title: "旧内容",
        },
        token,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await call(
        prefix + "/settings",
        { ...defaultAssistantSettings() },
        second.body.token,
        "PUT",
      )
    ).status,
  ).toBe(403);
});
it("无模型也能处理确定性命令、歧义先澄清，普通模型输出不执行操作", async () => {
  const provider = vi.fn().mockResolvedValue({
    text: "待办：这只是模型输出",
    usage: { inputTokens: 10, outputTokens: 10 },
  });
  const { call, token } = await setup({
    configDir: "",
    chatProvider: () => ({
      info: { id: "test", apiVersion: 1, locality: "local" },
      reply: provider,
    }),
  });
  const submit = async (id: string, text: string) => {
    await call(prefix + "/chat", { requestId: id, text }, token);
    await vi.waitFor(async () =>
      expect(
        (await call(prefix + `/chat/${id}`, undefined, token)).body.status,
      ).toBe("completed"),
    );
  };
  await submit("todo", "待办：买牛奶");
  await submit("ambiguous", "明天三点提醒我开会");
  let snapshot = (await call(prefix + "/snapshot", undefined, token)).body;
  expect(snapshot.todos).toHaveLength(1);
  expect(snapshot.reminders).toHaveLength(0);
  expect(provider).not.toHaveBeenCalled();
  const settings = defaultAssistantSettings();
  settings.chat = {
    ...settings.chat,
    enabled: true,
    baseUrl: "http://127.0.0.1:1/v1",
    model: "fixture",
  };
  expect(
    (await call(prefix + "/settings", settings, token, "PUT")).status,
  ).toBe(400); // schemaVersion 仅由服务管理。
  const { schemaVersion: _, ...input } = settings;
  expect((await call(prefix + "/settings", input, token, "PUT")).status).toBe(
    200,
  );
  await submit("model", "你好");
  snapshot = (await call(prefix + "/snapshot", undefined, token)).body;
  expect(snapshot.todos).toHaveLength(1);
  expect(snapshot.messages.at(-1).text).toContain("只是模型输出");
});
it("清空主会话后迟到回复和重试不能恢复历史，待办仍保留", async () => {
  let release: (value: ChatReply) => void = () => undefined;
  const provider = vi.fn(
    () =>
      new Promise<ChatReply>((resolve) => {
        release = resolve;
      }),
  );
  const { call, token } = await setup({
    configDir: "",
    chatProvider: () => ({
      info: { id: "test", apiVersion: 1, locality: "local" },
      reply: provider,
    }),
  });
  const { schemaVersion: _, ...settings } = defaultAssistantSettings();
  settings.chat = {
    ...settings.chat,
    enabled: true,
    baseUrl: "http://127.0.0.1:1/v1",
    model: "fixture",
  };
  await call(prefix + "/settings", settings, token, "PUT");
  await call(
    prefix + "/mutations",
    { requestId: "todo", action: "todo.create", title: "保留事项" },
    token,
  );
  const request = { requestId: "late", text: "这段历史需要清除" };
  await call(prefix + "/chat", request, token);
  await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce());
  const foreign = await call("/v1/pair", {
    name: "foreign",
    scopes: "assistant",
  });
  expect(
    (await call(prefix + "/chat/late/cancel", {}, foreign.body.token)).status,
  ).toBe(404);
  const preview = (
    await call(prefix + "/clear-preview", { scope: "history" }, token)
  ).body;
  expect(
    (
      await call(
        prefix + "/clear",
        { confirmationId: preview.confirmationId },
        token,
      )
    ).status,
  ).toBe(200);
  release({
    text: "旧内容不能回来",
    usage: { inputTokens: 10, outputTokens: 10 },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect((await call(prefix + "/chat", request, token)).body.status).toBe(
    "cleared",
  );
  const snapshot = (await call(prefix + "/snapshot", undefined, token)).body;
  expect(snapshot.messages).toEqual([]);
  expect(snapshot.todos).toHaveLength(1);
  expect(
    (
      await call(
        prefix + "/clear",
        { confirmationId: preview.confirmationId },
        token,
      )
    ).status,
  ).toBe(409);
});
it("勿扰保留待投递提醒，取消关联项后不再发送，补发区分系统受理与用户已看到", async () => {
  const { call, token, notifier } = await setup();
  expect((await call("/v1/dnd", { enabled: true }, token)).status).toBe(200);
  const todo = (
    await call(
      prefix + "/mutations",
      { requestId: "todo", action: "todo.create", title: "取消提醒的待办" },
      token,
    )
  ).body;
  expect(
    (
      await call(
        prefix + "/mutations",
        {
          requestId: "linked",
          action: "reminder.create",
          todoId: todo.todoId,
          message: "不应发送",
          remindAt: Date.now() + 100,
        },
        token,
      )
    ).status,
  ).toBe(200);
  await call(
    prefix + "/mutations",
    {
      requestId: "finish",
      action: "todo.update",
      id: todo.todoId,
      version: 1,
      completed: true,
    },
    token,
  );
  expect(
    (
      await call(
        prefix + "/mutations",
        {
          requestId: "independent",
          action: "reminder.create",
          message: "应补发",
          remindAt: Date.now() + 100,
        },
        token,
      )
    ).status,
  ).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(notifier).not.toHaveBeenCalled();
  await call("/v1/dnd", { enabled: false }, token);
  await vi.waitFor(() => expect(notifier).toHaveBeenCalledOnce());
  const reminders = (await call(prefix + "/snapshot", undefined, token)).body
    .reminders;
  expect(reminders.find((r: any) => r.message === "不应发送").status).toBe(
    "cancelled",
  );
  expect(reminders.find((r: any) => r.message === "应补发").status).toBe(
    "accepted",
  );
  expect(notifier.mock.calls[0]![0].body).not.toContain("不应发送");
});
it("模型密钥不回显，关闭自身云端能力后不调用 Provider，预览过期版本不能清空新事项", async () => {
  const provider = vi.fn();
  const { call, token, dir } = await setup({
    configDir: "",
    chatProvider: () => ({
      info: { id: "test", apiVersion: 1, locality: "cloud" },
      reply: provider,
    }),
  });
  const { schemaVersion: _, ...settings } = defaultAssistantSettings();
  settings.chat = {
    ...settings.chat,
    enabled: true,
    locality: "cloud",
    baseUrl: "https://example.test/v1",
    model: "fixture",
  };
  const saved = await call(
    prefix + "/settings",
    { ...settings, apiKey: "fixture-private-key" },
    token,
    "PUT",
  );
  expect(saved.status).toBe(200);
  expect(JSON.stringify(saved.body)).not.toContain("fixture-private-key");
  expect(saved.body.chat.apiKeyConfigured).toBe(true);
  expect(
    readdirSync(dir).some(
      (name) =>
        name.startsWith("assistant-key-") &&
        readFileSync(join(dir, name), "utf8") === "fixture-private-key",
    ),
  ).toBe(true);
  await call(prefix + "/chat", { requestId: "cloud", text: "你好" }, token);
  await vi.waitFor(async () =>
    expect(
      (await call(prefix + "/chat/cloud", undefined, token)).body.code,
    ).toBe("cloud_disabled"),
  );
  expect(provider).not.toHaveBeenCalled();
  const preview = (
    await call(prefix + "/clear-preview", { scope: "todos" }, token)
  ).body;
  await call(
    prefix + "/mutations",
    { requestId: "new", action: "todo.create", title: "新事项" },
    token,
  );
  expect(
    (
      await call(
        prefix + "/clear",
        { confirmationId: preview.confirmationId },
        token,
      )
    ).status,
  ).toBe(409);
});

it("撤销调用端会取消在途请求；Provider 忽略中止也不阻塞退出或写回结果", async () => {
  const provider = vi.fn(() => new Promise<ChatReply>(() => undefined));
  const { call, token, runtime } = await setup({
    configDir: "",
    chatProvider: () => ({
      info: { id: "fixture", apiVersion: 1, locality: "local" },
      reply: provider,
    }),
  });
  const { schemaVersion: _, ...settings } = defaultAssistantSettings();
  settings.chat = {
    ...settings.chat,
    enabled: true,
    baseUrl: "http://127.0.0.1:1/v1",
    model: "fixture",
  };
  await call(prefix + "/settings", settings, token, "PUT");
  await call(
    prefix + "/chat",
    { requestId: "x".repeat(80), text: "待办：长请求编号也能成功" },
    token,
  );
  await vi.waitFor(async () =>
    expect(
      (await call(prefix + `/chat/${"x".repeat(80)}`, undefined, token)).body
        .status,
    ).toBe("completed"),
  );
  await call(prefix + "/chat", { requestId: "hang", text: "你好" }, token);
  await vi.waitFor(() => expect(provider).toHaveBeenCalledOnce());
  const clients = (await call("/v1/clients")).body.clients as Array<{
    clientId: string;
    name: string;
  }>;
  const client = clients.find((c) => c.name === "assistant")!;
  expect((await call(`/v1/clients/${client.clientId}/revoke`, {})).status).toBe(
    200,
  );
  expect((await call(prefix + "/snapshot", undefined, token)).status).toBe(401);
  expect((await call(prefix + "/snapshot")).body.messages.at(-1).role).toBe(
    "user",
  );
  await Promise.race([
    runtime.stop(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("stop blocked")), 1000),
    ),
  ]);
});
