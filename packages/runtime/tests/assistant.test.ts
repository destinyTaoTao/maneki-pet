import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeOptions, StartedRuntime } from "../src/runtime.js";
import { defaultAssistantSettings } from "../src/assistant-settings.js";
import type { ChatReply } from "@maneki-pet/core";
import { createServer } from "node:http";
import { startFetchCompatibleRuntime } from "./fetch-compatible-runtime.js";
const dirs: string[] = [];
const runtimes: StartedRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
async function setup(
  options: Omit<RuntimeOptions, "port"> = { configDir: "" },
) {
  const dir = mkdtempSync(join(tmpdir(), "maneki-assistant-"));
  dirs.push(dir);
  const notifier = vi.fn().mockResolvedValue({ status: "accepted" });
  const runtime = await startFetchCompatibleRuntime({
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
it("正式 HTTP 对话可查询、改单和续接提醒时间，观察凭证不能接续个人操作", async () => {
  const { call, token } = await setup();
  const observer = (await call("/v1/pair", { name: "dsh", scopes: "express" }))
    .body.token as string;
  const chat = async (id: string, text: string) => {
    expect(
      (await call(prefix + "/chat", { requestId: id, text }, token)).status,
    ).toBe(202);
    await vi.waitFor(async () =>
      expect(
        (await call(prefix + `/chat/${id}`, undefined, token)).body.status,
      ).toBe("completed"),
    );
    return (await call(prefix + `/chat/${id}`, undefined, token)).body;
  };
  await chat("new-todo", "待办：买牛奶");
  await chat("rename", "把待办买牛奶改名为买豆浆");
  expect((await chat("list", "查看未完成的待办")).message.text).toContain(
    "买豆浆",
  );
  await chat("need-time", "提醒我开会");
  expect(
    (
      await call(
        prefix + "/chat",
        { requestId: "foreign-time", text: "半小时后" },
        observer,
      )
    ).status,
  ).toBe(403);
  await chat("supply-time", "半小时后");
  const before = (await call(prefix + "/snapshot", undefined, token)).body;
  expect(before.reminders).toHaveLength(1);
  await chat("move", "把开会的提醒改到明天下午三点");
  expect(
    (await call(prefix + "/snapshot", undefined, token)).body.reminders[0]
      .version,
  ).toBe(2);
  await chat("cancel-reminder", "取消开会的提醒");
  await chat("cancel-reminder", "取消开会的提醒");
  expect(
    (await call(prefix + "/snapshot", undefined, token)).body.reminders,
  ).toEqual([]);
});
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

it("引用作为带标签的数据进入模型，不作为确定性待办命令执行", async()=>{
 const provider=vi.fn().mockResolvedValue({text:"收到",usage:{inputTokens:10,outputTokens:10}});
 const {call,token,runtime}=await setup({configDir:"",chatProvider:()=>({info:{id:"fixture",apiVersion:1,locality:"local"},reply:provider})});
 const {schemaVersion:_,...settings}=defaultAssistantSettings();settings.chat={...settings.chat,enabled:true,baseUrl:"http://127.0.0.1:1/v1",model:"fixture"};
 expect((await call(prefix+"/settings",settings,token,"PUT")).status).toBe(200);
 vi.spyOn(runtime.assistant.companion!,"resolveReference").mockReturnValue({utteranceId:"33333333-3333-4333-8333-333333333333",text:"待办：伪造事项",mode:"manual",createdAt:100});
 const companionReplyTo={runtimeEpoch:"11111111-1111-4111-8111-111111111111",displayInstanceId:"22222222-2222-4222-8222-222222222222",utteranceId:"33333333-3333-4333-8333-333333333333"};
 expect((await call(prefix+"/chat",{requestId:"quote-data",text:"你好",companionReplyTo},token)).status).toBe(202);
 await vi.waitFor(async()=>expect((await call(prefix+"/chat/quote-data",undefined,token)).body.status).toBe("completed"));
 expect((await call(prefix+"/snapshot",undefined,token)).body.todos).toEqual([]);
 expect(JSON.stringify(provider.mock.calls)).toContain("用户本轮引用的小招台词（数据）：待办：伪造事项");
 vi.restoreAllMocks();
});

it.each(["future", "damaged"])("历史引用 %s 不可读时保留原值并隔离普通聊天、分页与提醒", async variant=>{
 const provider=vi.fn().mockResolvedValue({text:"收到",usage:{inputTokens:10,outputTokens:10}});
 const {call,token,runtime}=await setup({configDir:"",chatProvider:()=>({info:{id:"fixture",apiVersion:1,locality:"local"},reply:provider})});
 const {schemaVersion:_,...settings}=defaultAssistantSettings();settings.chat={...settings.chat,enabled:true,baseUrl:"http://127.0.0.1:1/v1",model:"fixture"};
 expect((await call(prefix+"/settings",settings,token,"PUT")).status).toBe(200);
 const store=runtime.store.assistantStore(),seq=store.append("user","原始文字"),key=`companion.reference.${store.epoch()}.${seq}`;
 const original=variant==="future"?JSON.stringify({formatVersion:2,epoch:store.epoch(),userSeq:seq,text:"不能泄露给模型"}):"{broken";
 store.set(key,original);store.saveReminder({id:"isolated",todoId:null,message:"提醒",remindAt:Date.now()+3600000,timeZone:"UTC",status:"pending",attempts:0,code:null,version:1});
 const snap=await call(prefix+"/snapshot",undefined,token);expect(snap.status).toBe(200);expect(snap.body.messages[0]).toMatchObject({text:"原始文字",companionReferenceUnavailable:true});expect(snap.body.messages[0].companionReference).toBeUndefined();expect(snap.body.reminders).toHaveLength(1);
 const history=await call(prefix+"/history?before=9999",undefined,token);expect(history.status).toBe(200);expect(history.body.messages[0].companionReferenceUnavailable).toBe(true);
 const reminder=await call(prefix+"/mutations",{requestId:"reminder-after-corrupt",action:"reminder.create",message:"后续提醒",remindAt:Date.now()+7200000},token);expect(reminder.status).toBe(200);
 expect((await call(prefix+"/chat",{requestId:"normal",text:"你好"},token)).status).toBe(202);
 await vi.waitFor(async()=>expect((await call(prefix+"/chat/normal",undefined,token)).body.status).toBe("completed"));
 const sent=JSON.stringify(provider.mock.calls);expect(sent).toContain("引用内容不可用");expect(sent).not.toContain("不能泄露给模型");expect(store.get(key)).toBe(original);
 store.set(key,JSON.stringify({formatVersion:1,epoch:store.epoch(),userSeq:seq,utteranceId:"33333333-3333-4333-8333-333333333333",text:"已恢复",mode:"manual",createdAt:100}));
 const recovered=(await call(prefix+"/snapshot",undefined,token)).body.messages[0];expect(recovered.companionReference.text).toBe("已恢复");expect(recovered.companionReferenceUnavailable).toBeUndefined();
});

it("摘要涵盖不可读引用后，引用恢复仍可进入下一轮模型上下文",async()=>{
 const provider=vi.fn().mockResolvedValue({text:"收到",usage:{inputTokens:10,outputTokens:10}});
 const {call,token,runtime}=await setup({configDir:"",chatProvider:()=>({info:{id:"fixture",apiVersion:1,locality:"local"},reply:provider})});
 const {schemaVersion:_,...settings}=defaultAssistantSettings();settings.chat={...settings.chat,enabled:true,baseUrl:"http://127.0.0.1:1/v1",model:"fixture"};expect((await call(prefix+"/settings",settings,token,"PUT")).status).toBe(200);
 const store=runtime.store.assistantStore(),seq=store.append("user","这是一段原文"),key=`companion.reference.${store.epoch()}.${seq}`;
 store.set(key,JSON.stringify({formatVersion:2,epoch:store.epoch(),userSeq:seq,text:"不可读取"}));
 for(let i=0;i<30;i++)store.append("user",`历史 ${i}`);
 const chat=async(id:string)=>{expect((await call(prefix+"/chat",{requestId:id,text:"你好"},token)).status).toBe(202);await vi.waitFor(async()=>expect((await call(prefix+`/chat/${id}`,undefined,token)).body.status).toBe("completed"));};
 await chat("before-recover");expect(JSON.stringify(provider.mock.calls.at(-1))).toContain("引用内容不可用");
 const oldSummary=JSON.parse(store.get("summary")!);store.set("summary",JSON.stringify({through:oldSummary.through,text:oldSummary.text})); // 模拟旧版保存摘要

 store.set(key,JSON.stringify({formatVersion:1,epoch:store.epoch(),userSeq:seq,utteranceId:"33333333-3333-4333-8333-333333333333",text:"恢复后的台词",mode:"manual",createdAt:100}));
 await chat("after-recover");expect(JSON.stringify(provider.mock.calls.at(-1))).toContain("恢复后的台词");
});

it("超过窗口的未识别引用不能被摘要静默跨越",async()=>{
 const provider=vi.fn().mockResolvedValue({text:"收到",usage:{inputTokens:10,outputTokens:10}});
 const {call,token,runtime}=await setup({configDir:"",chatProvider:()=>({info:{id:"fixture",apiVersion:1,locality:"local"},reply:provider})});
 const {schemaVersion:_,...settings}=defaultAssistantSettings();settings.chat={...settings.chat,enabled:true,baseUrl:"http://127.0.0.1:1/v1",model:"fixture"};expect((await call(prefix+"/settings",settings,token,"PUT")).status).toBe(200);
 const store=runtime.store.assistantStore();store.transaction(()=>{for(let i=0;i<90;i++){const seq=store.append("user",`历史 ${i}`);store.set(`companion.reference.${store.epoch()}.${seq}`,JSON.stringify({formatVersion:2,epoch:store.epoch(),userSeq:seq}));}});
 expect((await call(prefix+"/chat",{requestId:"overflow",text:"你好"},token)).status).toBe(202);
 await vi.waitFor(async()=>expect((await call(prefix+"/chat/overflow",undefined,token)).body.status).toBe("failed"));
 expect((await call(prefix+"/chat/overflow",undefined,token)).body.code).toBe("companion_reference_context_unavailable");expect(provider).not.toHaveBeenCalled();
});

it("64条待恢复引用满额时不越过新引用，修复后可以逐步继续",async()=>{
 const provider=vi.fn().mockResolvedValue({text:"收到",usage:{inputTokens:10,outputTokens:10}});
 const {call,token,runtime}=await setup({configDir:"",chatProvider:()=>({info:{id:"fixture",apiVersion:1,locality:"local"},reply:provider})});
 const {schemaVersion:_,...settings}=defaultAssistantSettings();settings.chat={...settings.chat,enabled:true,baseUrl:"http://127.0.0.1:1/v1",model:"fixture"};expect((await call(prefix+"/settings",settings,token,"PUT")).status).toBe(200);
 const store=runtime.store.assistantStore(),seqs:number[]=[];store.transaction(()=>{for(let i=0;i<66;i++){const seq=store.append("user",`引用消息${i}`);seqs.push(seq);store.set(`companion.reference.${store.epoch()}.${seq}`,JSON.stringify({formatVersion:2,epoch:store.epoch(),userSeq:seq}));}for(let i=0;i<26;i++)store.append("user",`普通消息${i}`);store.set("summary",JSON.stringify({through:seqs[63],text:"已有摘要",pendingReferenceSeqs:seqs.slice(0,64)}));});
 const send=async(id:string)=>{expect((await call(prefix+"/chat",{requestId:id,text:"你好"},token)).status).toBe(202);let result:any;await vi.waitFor(async()=>{result=(await call(prefix+`/chat/${id}`,undefined,token)).body;expect(result.status).not.toBe("pending");});return result;};
 expect((await send("at-cap")).code).toBe("companion_reference_context_unavailable");expect(provider).not.toHaveBeenCalled();expect(JSON.parse(store.get("summary")!).through).toBe(seqs[63]);
 for(let i=0;i<2;i++){const seq=seqs[i]!;store.set(`companion.reference.${store.epoch()}.${seq}`,JSON.stringify({formatVersion:1,epoch:store.epoch(),userSeq:seq,utteranceId:"33333333-3333-4333-8333-333333333333",text:`恢复台词${i}`,mode:"manual",createdAt:100}));}
 expect((await send("after-repair")).status).toBe("completed");expect(JSON.stringify(provider.mock.calls)).toContain("恢复台词0");expect(JSON.parse(store.get("summary")!).pendingReferenceSeqs).toEqual(seqs.slice(1,64));
});

it("旧版覆盖摘要后65条健康引用不阻断普通模型聊天",async()=>{
 const provider=vi.fn().mockResolvedValue({text:"收到",usage:{inputTokens:10,outputTokens:10}});
 const {call,token,runtime}=await setup({configDir:"",chatProvider:()=>({info:{id:"fixture",apiVersion:1,locality:"local"},reply:provider})});
 const {schemaVersion:_,...settings}=defaultAssistantSettings();settings.chat={...settings.chat,enabled:true,baseUrl:"http://127.0.0.1:1/v1",model:"fixture"};expect((await call(prefix+"/settings",settings,token,"PUT")).status).toBe(200);
 const store=runtime.store.assistantStore();let last=0;store.transaction(()=>{for(let i=0;i<65;i++){last=store.append("user",`旧消息${i}`);store.set(`companion.reference.${store.epoch()}.${last}`,JSON.stringify({formatVersion:1,epoch:store.epoch(),userSeq:last,utteranceId:"33333333-3333-4333-8333-333333333333",text:`健康台词${i}`,mode:"manual",createdAt:100}));}store.set("summary",JSON.stringify({through:last,text:"旧版摘要"}));});
 expect((await call(prefix+"/chat",{requestId:"legacy-healthy",text:"你好"},token)).status).toBe(202);
 let response:any;await vi.waitFor(async()=>{response=(await call(prefix+"/chat/legacy-healthy",undefined,token)).body;expect(response.status).not.toBe("pending");});
 expect(response.status).toBe("completed");expect(provider).toHaveBeenCalledOnce();expect(JSON.stringify(provider.mock.calls)).toContain("健康台词64");expect(JSON.parse(store.get("summary")!).pendingReferenceSeqs).toEqual([]);
});

it("大量其他会话孤儿键不影响旧摘要的当前会话引用恢复",async()=>{
 const provider=vi.fn().mockResolvedValue({text:"收到",usage:{inputTokens:10,outputTokens:10}});
 const {call,token,runtime}=await setup({configDir:"",chatProvider:()=>({info:{id:"fixture",apiVersion:1,locality:"local"},reply:provider})});const {schemaVersion:_,...settings}=defaultAssistantSettings();settings.chat={...settings.chat,enabled:true,baseUrl:"http://127.0.0.1:1/v1",model:"fixture"};expect((await call(prefix+"/settings",settings,token,"PUT")).status).toBe(200);
 const store=runtime.store.assistantStore();store.transaction(()=>{for(let i=0;i<300;i++)store.set(`companion.reference.999.${i}`,JSON.stringify({formatVersion:2,epoch:999,userSeq:i}));const seq=store.append("user","旧消息");store.set(`companion.reference.${store.epoch()}.${seq}`,JSON.stringify({formatVersion:1,epoch:store.epoch(),userSeq:seq,utteranceId:"33333333-3333-4333-8333-333333333333",text:"当前会话",mode:"manual",createdAt:100}));store.set("summary",JSON.stringify({through:seq,text:"旧摘要"}));});
 expect((await call(prefix+"/chat",{requestId:"orphan-count",text:"你好"},token)).status).toBe(202);let result:any;await vi.waitFor(async()=>{result=(await call(prefix+"/chat/orphan-count",undefined,token)).body;expect(result.status).not.toBe("pending");});expect(result.status).toBe("completed");expect(JSON.stringify(provider.mock.calls)).toContain("当前会话");
});
it("历史窗口间隙内超过256条健康引用仍能正常聊天",async()=>{
 const provider=vi.fn().mockResolvedValue({text:"收到",usage:{inputTokens:10,outputTokens:10}});const {call,token,runtime}=await setup({configDir:"",chatProvider:()=>({info:{id:"fixture",apiVersion:1,locality:"local"},reply:provider})});
 const {schemaVersion:_,...settings}=defaultAssistantSettings();settings.chat={...settings.chat,enabled:true,baseUrl:"http://127.0.0.1:1/v1",model:"fixture"};expect((await call(prefix+"/settings",settings,token,"PUT")).status).toBe(200);
 const store=runtime.store.assistantStore();store.transaction(()=>{for(let i=0;i<330;i++){const seq=store.append("user",`历史${i}`);store.set(`companion.reference.${store.epoch()}.${seq}`,JSON.stringify({formatVersion:1,epoch:store.epoch(),userSeq:seq,utteranceId:"33333333-3333-4333-8333-333333333333",text:`健康${i}`,mode:"manual",createdAt:100}));}});
 expect((await call(prefix+"/chat",{requestId:"healthy-gap",text:"你好"},token)).status).toBe(202);let result:any;await vi.waitFor(async()=>{result=(await call(prefix+"/chat/healthy-gap",undefined,token)).body;expect(result.status).not.toBe("pending");});expect(result.status).toBe("completed");expect(provider).toHaveBeenCalledOnce();
});

it("待处理列表中64条均已修复时，不因新增不可读引用而卡死",async()=>{
 const provider=vi.fn().mockResolvedValue({text:"收到",usage:{inputTokens:10,outputTokens:10}});const {call,token,runtime}=await setup({configDir:"",chatProvider:()=>({info:{id:"fixture",apiVersion:1,locality:"local"},reply:provider})});
 const {schemaVersion:_,...settings}=defaultAssistantSettings();settings.chat={...settings.chat,enabled:true,baseUrl:"http://127.0.0.1:1/v1",model:"fixture"};expect((await call(prefix+"/settings",settings,token,"PUT")).status).toBe(200);
 const store=runtime.store.assistantStore(),seqs:number[]=[];store.transaction(()=>{for(let i=0;i<69;i++){const seq=store.append("user",`引用${i}`);seqs.push(seq);store.set(`companion.reference.${store.epoch()}.${seq}`,JSON.stringify(i<64?{formatVersion:1,epoch:store.epoch(),userSeq:seq,utteranceId:"33333333-3333-4333-8333-333333333333",text:`已恢复${i}`,mode:"manual",createdAt:100}:{formatVersion:2,epoch:store.epoch(),userSeq:seq}));}for(let i=0;i<26;i++)store.append("user",`消息${i}`);store.set("summary",JSON.stringify({through:seqs[63],text:"旧摘要",pendingReferenceSeqs:seqs.slice(0,64)}));});
 expect((await call(prefix+"/chat",{requestId:"healthy-pending",text:"你好"},token)).status).toBe(202);let result:any;await vi.waitFor(async()=>{result=(await call(prefix+"/chat/healthy-pending",undefined,token)).body;expect(result.status).not.toBe("pending");});expect(result.status).toBe("completed");expect(JSON.parse(store.get("summary")!).pendingReferenceSeqs).toEqual(seqs.slice(1,64));expect(JSON.parse(store.get("summary")!).through).toBe(seqs[63]);
});

it("范围内第二页的损坏引用不能被健康引用掩盖",async()=>{
 const provider=vi.fn().mockResolvedValue({text:"收到",usage:{inputTokens:10,outputTokens:10}});const {call,token,runtime}=await setup({configDir:"",chatProvider:()=>({info:{id:"fixture",apiVersion:1,locality:"local"},reply:provider})});
 const {schemaVersion:_,...settings}=defaultAssistantSettings();settings.chat={...settings.chat,enabled:true,baseUrl:"http://127.0.0.1:1/v1",model:"fixture"};expect((await call(prefix+"/settings",settings,token,"PUT")).status).toBe(200);
 const store=runtime.store.assistantStore();store.transaction(()=>{for(let i=0;i<330;i++){const seq=store.append("user",`历史${i}`);store.set(`companion.reference.${store.epoch()}.${seq}`,JSON.stringify(i===180?{formatVersion:2,epoch:store.epoch(),userSeq:seq}:{formatVersion:1,epoch:store.epoch(),userSeq:seq,utteranceId:"33333333-3333-4333-8333-333333333333",text:`健康${i}`,mode:"manual",createdAt:100}));}});
 expect((await call(prefix+"/chat",{requestId:"bad-page-2",text:"你好"},token)).status).toBe(202);let result:any;await vi.waitFor(async()=>{result=(await call(prefix+"/chat/bad-page-2",undefined,token)).body;expect(result.status).not.toBe("pending");});expect(result.code).toBe("companion_reference_context_unavailable");expect(provider).not.toHaveBeenCalled();
});

it("64条已恢复引用跨多轮逐条进入真实 provider 请求后才移出待处理",async()=>{
 const provider=vi.fn().mockResolvedValue({text:"收到",usage:{inputTokens:10,outputTokens:10}});const {call,token,runtime}=await setup({configDir:"",chatProvider:()=>({info:{id:"fixture",apiVersion:1,locality:"local"},reply:provider})});
 const {schemaVersion:_,...settings}=defaultAssistantSettings();settings.chat={...settings.chat,enabled:true,baseUrl:"http://127.0.0.1:1/v1",model:"fixture",maxOutputTokens:64};expect((await call(prefix+"/settings",settings,token,"PUT")).status).toBe(200);
 const store=runtime.store.assistantStore(),seqs:number[]=[];store.transaction(()=>{for(let i=0;i<64;i++){const seq=store.append("user",`引用${i}`);seqs.push(seq);store.set(`companion.reference.${store.epoch()}.${seq}`,JSON.stringify({formatVersion:1,epoch:store.epoch(),userSeq:seq,utteranceId:"33333333-3333-4333-8333-333333333333",text:`恢复标签${String(i).padStart(2,"0")}结束`,mode:"manual",createdAt:100}));}store.set("summary",JSON.stringify({through:seqs[63],text:"旧摘要",pendingReferenceSeqs:seqs}));});
 for(let i=0;i<64;i++){const id=`recover-${i}`;expect((await call(prefix+"/chat",{requestId:id,text:"你好"},token)).status).toBe(202);await vi.waitFor(async()=>expect((await call(prefix+`/chat/${id}`,undefined,token)).body.status).toBe("completed"));const pending=JSON.parse(store.get("summary")!).pendingReferenceSeqs;expect(pending).toHaveLength(63-i);}
 expect(provider).toHaveBeenCalledTimes(64);const sent=JSON.stringify(provider.mock.calls);for(let i=0;i<64;i++)expect(sent).toContain(`恢复标签${String(i).padStart(2,"0")}结束`);
},30000);

it("provider 失败时恢复引用仍保留待处理，成功后才移除",async()=>{
 const provider=vi.fn().mockRejectedValueOnce(Error("fixture")) .mockResolvedValue({text:"收到",usage:{inputTokens:10,outputTokens:10}});const {call,token,runtime}=await setup({configDir:"",chatProvider:()=>({info:{id:"fixture",apiVersion:1,locality:"local"},reply:provider})});
 const {schemaVersion:_,...settings}=defaultAssistantSettings();settings.chat={...settings.chat,enabled:true,baseUrl:"http://127.0.0.1:1/v1",model:"fixture",maxOutputTokens:64};expect((await call(prefix+"/settings",settings,token,"PUT")).status).toBe(200);
 const store=runtime.store.assistantStore(),seq=store.append("user","旧消息");store.set(`companion.reference.${store.epoch()}.${seq}`,JSON.stringify({formatVersion:1,epoch:store.epoch(),userSeq:seq,utteranceId:"33333333-3333-4333-8333-333333333333",text:"恢复内容",mode:"manual",createdAt:100}));store.set("summary",JSON.stringify({through:seq,text:"旧摘要",pendingReferenceSeqs:[seq]}));
 const send=async(id:string)=>{expect((await call(prefix+"/chat",{requestId:id,text:"你好"},token)).status).toBe(202);let result:any;await vi.waitFor(async()=>{result=(await call(prefix+`/chat/${id}`,undefined,token)).body;expect(result.status).not.toBe("pending");});return result;};
 expect((await send("fails" )).status).toBe("failed");expect(JSON.parse(store.get("summary")!).pendingReferenceSeqs).toEqual([seq]);expect((await send("retry" )).status).toBe("completed");expect(JSON.parse(store.get("summary")!).pendingReferenceSeqs).toEqual([]);expect(JSON.stringify(provider.mock.calls)).toContain("恢复内容");
});

it("五万条无引用历史的范围检查不扫描消息且不妨碍隔离提醒调度",async()=>{
 let deliveredAt=0;const notify=vi.fn(async()=>{deliveredAt=Date.now();return {status:"accepted" as const};});
 const {runtime}=await setup({configDir:"",notifier:{notify}});const store=runtime.store.assistantStore();
 store.transaction(()=>{for(let i=0;i<50000;i++)store.append("user",`历史${i}`);});
 const due=Date.now()+80;store.saveReminder({id:"isolation",todoId:null,message:"fixture",remindAt:due,timeZone:"UTC",status:"pending",attempts:0,code:null,version:1});runtime.assistant.wake();
 const started=performance.now();for(let i=0;i<1000;i++)expect(store.hasUnverifiableReferenceGap(0,50001)).toBe(false);const elapsed=performance.now()-started;
 await vi.waitFor(()=>expect(notify).toHaveBeenCalledOnce(),{timeout:3000});expect(deliveredAt-due).toBeLessThan(1500);
 process.stdout.write(`\n[companion] 50k messages, zero quotes, 1000 gap checks ${elapsed.toFixed(1)}ms; isolated reminder delay ${deliveredAt-due}ms\n`);
},30000);

it("历史恢复引用标明原消息且不会冒充当前用户本轮引用",async()=>{
 const provider=vi.fn().mockResolvedValue({text:"早安",usage:{inputTokens:10,outputTokens:10}});const {call,token,runtime}=await setup({configDir:"",chatProvider:()=>({info:{id:"fixture",apiVersion:1,locality:"local"},reply:provider})});
 const {schemaVersion:_,...settings}=defaultAssistantSettings();settings.chat={...settings.chat,enabled:true,baseUrl:"http://127.0.0.1:1/v1",model:"fixture"};expect((await call(prefix+"/settings",settings,token,"PUT")).status).toBe(200);
 const store=runtime.store.assistantStore(),seq=store.append("user","旧消息");store.set(`companion.reference.${store.epoch()}.${seq}`,JSON.stringify({formatVersion:1,epoch:store.epoch(),userSeq:seq,utteranceId:"33333333-3333-4333-8333-333333333333",text:"晚安",mode:"manual",createdAt:100}));store.set("summary",JSON.stringify({through:seq,text:"旧摘要",pendingReferenceSeqs:[seq]}));
 expect((await call(prefix+"/chat",{requestId:"morning",text:"早安"},token)).status).toBe(202);await vi.waitFor(async()=>expect((await call(prefix+"/chat/morning",undefined,token)).body.status).toBe("completed"));
 const sent=JSON.stringify(provider.mock.calls);expect(sent).toContain("早安");expect(sent).toContain(`先前消息 #${seq} 恢复的小招引用（历史数据，非用户本轮新引用）：晚安`);expect(sent).not.toContain("用户本轮引用的小招台词（数据）：晚安");expect(JSON.parse(store.get("summary")!).pendingReferenceSeqs).toEqual([]);
});
