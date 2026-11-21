import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentReminderReceipt } from "@maneki-pet/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantStore } from "../src/assistant-store.js";
import type { StartedRuntime } from "../src/runtime.js";
import { startFetchCompatibleRuntime } from "./fetch-compatible-runtime.js";

let directory: string, runtime: StartedRuntime, now: number;
const notify = vi.fn(async () => ({ status: "accepted" as const }));
const input = { requestId: "intent-1", afterSeconds: 60, message: "查看构建" };

function start() {
  return startFetchCompatibleRuntime({ configDir: directory, notifier: { notify } });
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "maneki-agent-reminder-"));
  now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  notify.mockClear();
  runtime = await start();
});
afterEach(async () => {
  await runtime.stop();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function call(path: string, token?: string, body?: unknown) {
  return fetch(`http://127.0.0.1:${runtime.port}/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function pair(name: string, scopes = "reminder_create") {
  const res = await call("/pair", runtime.rootToken, { name, scopes });
  expect(res.status).toBe(200);
  return await res.json() as { token: string; clientId: string };
}
async function create(token: string, args = input): Promise<AgentReminderReceipt> {
  const res = await call("/reminders", token, args);
  expect(res.status).toBe(200);
  return await res.json() as AgentReminderReceipt;
}
function revoke(name: string) {
  return call("/admin/reminders/revoke", runtime.rootToken, { name });
}

it("具名授权独立签发和撤销，证明域、身份探针和业务路由均按能力隔离", async () => {
  const name = "dsh", scope = "reminder_create";
  const grants = await Promise.all([1, 2].map(() => call("/pair", runtime.rootToken, { name, scopes: scope })));
  expect(grants.map(res => res.status).sort()).toEqual([200, 409]);
  const writer = await grants.find(res => res.ok)!.json() as { token: string; clientId: string };
  const briefing = await pair(name, "briefing_read");
  const challenge = randomBytes(32).toString("base64url");
  async function proof(clientId: string, nonce = challenge) {
    const headers: Record<string, string> = {};
    for (const purpose of ["reminder", "briefing", "expression"]) {
      headers[`x-maneki-${purpose}-client`] = clientId;
      headers[`x-maneki-${purpose}-challenge`] = nonce;
    }
    const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/health`, { headers });
    return await res.json() as Record<string, unknown>;
  }
  const expected = createHmac("sha256", createHash("sha256").update(writer.token).digest())
    .update(JSON.stringify(["maneki-reminder-proof-v1", writer.clientId, challenge, runtime.instanceId, runtime.port])).digest("hex");
  const health = await proof(writer.clientId);
  expect(health.reminderProof).toBe(expected);
  expect(health.briefingProof).toBeUndefined();
  expect(health.expressionProof).toBeUndefined();
  expect((await proof(writer.clientId, "short")).reminderProof).toBeUndefined();
  expect((await proof(briefing.clientId)).reminderProof).toBeUndefined();
  expect(await (await call("/reminders/identity", writer.token)).json()).toEqual({ name, clientId: writer.clientId });
  for (const scopes of ["express", "assistant,settings", "settings", "notify", "tasks", "speech_host"]) {
    const legacy = await pair(name, scopes);
    expect((await call("/reminders", legacy.token, input)).status).toBe(403);
    expect((await call("/reminders/identity", legacy.token)).status).toBe(403);
    expect((await proof(legacy.clientId)).reminderProof).toBeUndefined();
    expect((await call("/pair", runtime.rootToken, { name, scopes: `${scopes},${scope}` })).status).toBe(400);
  }
  for (const [badName, scopes] of [["invalid name", scope], [" ", scope], ["a".repeat(49), scope], [name, `${scope},briefing_read`], [name, `${scope},${scope}`]]) {
    expect((await call("/pair", runtime.rootToken, { name: badName, scopes })).status).toBe(400);
  }
  for (const path of ["/reminders", "/briefing", "/assistant/snapshot", "/assistant/settings", "/clients", "/dnd", "/limits", "/expressions/state", "/tasks/any"]) {
    expect((await call(path, writer.token)).status).toBe(403);
  }
  for (const path of ["/reminders/identity", "/assistant/mutations", "/pair", "/ws-ticket", "/admin/reminders/revoke", "/tasks", "/shutdown"]) {
    expect((await call(path, writer.token, {})).status).toBe(403);
  }
  expect((await call("/reminders", undefined, input)).status).toBe(401);
  expect((await call("/reminders", runtime.rootToken, input)).status).toBe(403);
  expect((await call("/reminders", briefing.token, input)).status).toBe(403);
  expect((await revoke("unknown")).status).toBe(404);
  expect((await revoke("invalid name")).status).toBe(400);
  expect(await (await revoke(name)).json()).toEqual({ revoked: writer.clientId });
  const count = runtime.store.auditCount();
  expect(await (await revoke(name)).json()).toEqual({ revoked: writer.clientId });
  expect(runtime.store.auditCount()).toBe(count);
  expect((await proof(writer.clientId)).reminderProof).toBeUndefined();
  expect((await call("/reminders", writer.token, input)).status).toBe(401);
  expect((await call("/pair", runtime.rootToken, { name, scopes: scope })).status).toBe(409);
  expect((await call("/briefing/identity", briefing.token)).status).toBe(200);
});

it("并发相同请求只写一条，以首次相对时间返回；本人更新或删除及 Runtime 重启后重放无副作用", async () => {
  const a = await pair("owner-a"), b = await pair("owner-b");
  let store = runtime.store.assistantStore();
  const revision = store.revision();
  const replies = await Promise.all([create(a.token, { ...input, message: "  查看构建 " }), create(a.token)]);
  const receipt = replies[0]!;
  expect(replies[1]).toEqual(receipt);
  expect(receipt).toEqual({ requestId: input.requestId, reminderId: expect.stringMatching(/^[0-9a-f-]{36}$/), remindAt: now + 60_000 });
  expect(store.revision()).toBe(revision + 1);
  expect(store.reminders()).toHaveLength(1);
  expect(store.reminder(receipt.reminderId)?.message).toBe(input.message);
  const other = await create(b.token);
  expect(other.reminderId).not.toBe(receipt.reminderId);
  for (const change of [{ message: "不同内容" }, { afterSeconds: 61 }]) {
    expect((await call("/reminders", a.token, { ...input, ...change })).status).toBe(409);
  }
  const edit = { action: "reminder.update", requestId: "user-edit", id: receipt.reminderId, version: 1, message: "用户已改", remindAt: now + 120_000 };
  expect((await call("/assistant/mutations", runtime.rootToken, edit)).status).toBe(200);
  expect(await create(a.token)).toEqual(receipt);
  expect(store.reminder(receipt.reminderId)).toMatchObject({ message: "用户已改", remindAt: edit.remindAt, version: 2 });
  expect((await call("/assistant/mutations", runtime.rootToken, { action: "reminder.delete", requestId: "user-delete", id: receipt.reminderId, version: 2 })).status).toBe(200);
  await runtime.stop();
  now += 180_000;
  runtime = await start();
  store = runtime.store.assistantStore();
  await vi.waitFor(() => expect(store.reminder(other.reminderId)?.status).toBe("accepted"));
  const finalRevision = store.revision();
  expect(await create(a.token)).toEqual(receipt);
  expect(await create(b.token)).toEqual(other);
  expect(store.revision()).toBe(finalRevision);
  expect(store.reminders().map(item => item.id)).toEqual([other.reminderId]);
  expect(notify).toHaveBeenCalledTimes(1);
});

it("严格验证请求，容量与本地提醒共享，回执写入失败回滚整笔事务", async () => {
  const writer = await pair("fixture");
  const store = runtime.store.assistantStore(), revision = store.revision();
  for (const body of [[], {}, { ...input, requestId: "x+" }, { ...input, afterSeconds: 0 }, { ...input, afterSeconds: 31622401 },
    { ...input, afterSeconds: 1.5 }, { ...input, afterSeconds: "1" }, { ...input, message: " " }, { ...input, message: "猫".repeat(513) },
    { ...input, action: "reminder.delete" }, { ...input, remindAt: now }, { ...input, clientId: "other" }]) {
    expect((await call("/reminders", writer.token, body)).status).toBe(400);
  }
  const failure = vi.spyOn(AssistantStore.prototype, "rememberMutation").mockImplementationOnce(() => { throw new Error("fixture"); });
  expect((await call("/reminders", writer.token, input)).status).toBe(500);
  failure.mockRestore();
  expect(store.reminders()).toHaveLength(0);
  expect(store.revision()).toBe(revision);
  expect(store.mutation(writer.clientId, input.requestId)).toBeUndefined();
  const args = { ...input, afterSeconds: 31622400 };
  const receipt = await create(writer.token, args);
  expect(receipt.remindAt).toBe(now + 31622400000);
  const item = store.reminder(receipt.reminderId)!;
  store.transaction(() => {
    for (let i = 1; i < 200; i++) store.saveReminder({ ...item, id: `existing-${i}` });
  });
  expect(await create(writer.token, args)).toEqual(receipt);
  const res = await call("/reminders", writer.token, { ...input, requestId: "overflow" });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "reminder_limit" });
});

it("拒绝无法无损存储或发送的字符，不占额度；表情、换行和 XML 标点原样保存", async () => {
  const writer = await pair("unicode");
  const store = runtime.store.assistantStore(), revision = store.revision();
  const quotaKey = `reminderCreationQuota.${writer.clientId}`;
  for (const codeUnit of [0x0000, 0x0001, 0xd800, 0xdc00, 0xfffe, 0xffff]) {
    const message = `开始${String.fromCharCode(codeUnit)}结束`;
    const res = await call("/reminders", writer.token, { ...input, message });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "reminder_input_invalid" });
  }
  expect(store.revision()).toBe(revision);
  expect(store.reminders()).toEqual([]);
  expect(store.mutation(writer.clientId, input.requestId)).toBeUndefined();
  expect(store.get(quotaKey)).toBeNull();
  const message = "检查 🐈 和 👩🏽‍💻\n<完成> & 归档";
  const result = await create(writer.token, { ...input, message });
  expect(store.reminder(result.reminderId)?.message).toBe(message);
  expect(notify).not.toHaveBeenCalled();
});

it("配额记录损坏时返回明确的 503，未覆盖存储或向调用方泄露损坏数据", async () => {
  const writer = await pair("corrupt-quota");
  const store = runtime.store.assistantStore();
  const original = await create(writer.token);
  const revision = store.revision(), quotaKey = `reminderCreationQuota.${writer.clientId}`;
  const args = { ...input, requestId: "next-intent" };
  for (const damaged of ["fixture-private-quota-content", '{"hour":42,"count":"fixture-private-quota-content"}']) {
    store.set(quotaKey, damaged);
    const res = await call("/reminders", writer.token, args);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "reminder_quota_unavailable" });
    expect(store.get(quotaKey)).toBe(damaged);
    expect(store.mutation(writer.clientId, args.requestId)).toBeUndefined();
    expect(await create(writer.token)).toEqual(original);
  }
  expect(store.revision()).toBe(revision);
  expect(store.reminders()).toHaveLength(1);
});

it("按各身份和 UTC 整点小时持久计数，重放、冲突和回滚不额外扣减，回拨不能重置额度", async () => {
  const writer = await pair("agent-a"), other = await pair("agent-b");
  const args = { ...input, afterSeconds: 86_400 };
  now = Date.parse("2026-11-21T10:59:59.999Z");
  const original = await create(writer.token, args);
  const failedWrite = vi.spyOn(AssistantStore.prototype, "rememberMutation")
    .mockImplementationOnce(() => { throw new Error("fixture-write-failed"); });
  expect((await call("/reminders", writer.token, { ...args, requestId: "failed" })).status).toBe(500);
  failedWrite.mockRestore();
  for (let i = 1; i < 30; i++) await create(writer.token, { ...args, requestId: `hour-${i}` });
  const overflow = { ...args, requestId: "overflow" };
  expect((await call("/reminders", writer.token, overflow)).status).toBe(429);
  await runtime.stop();
  runtime = await start();
  const store = runtime.store.assistantStore(), revision = store.revision();
  expect(await create(writer.token, args)).toEqual(original);
  expect((await call("/reminders", writer.token, { ...args, afterSeconds: 1 })).status).toBe(409);
  expect((await call("/reminders", writer.token, overflow)).status).toBe(429);
  now -= 3_600_000;
  expect((await call("/reminders", writer.token, overflow)).status).toBe(429);
  expect(store.revision()).toBe(revision);
  expect(await create(other.token, args)).toMatchObject({ requestId: args.requestId });
  now = Date.parse("2026-11-21T11:00:00Z");
  expect(await create(writer.token, overflow)).toMatchObject({ requestId: "overflow", remindAt: now + 86_400_000 });
  expect(store.reminders()).toHaveLength(32);
});

it("撤销发生在读请求体期间则拒绝创建，已安排的提醒继续遵循勿扰并只投递一次", async () => {
  const writer = await pair("agent");
  runtime.store.kvSet("dnd", "1");
  const scheduled = await create(writer.token, { ...input, afterSeconds: 1 });
  expect(notify).not.toHaveBeenCalled();
  const payload = JSON.stringify({ ...input, requestId: "in-flight" });
  const req = request({ hostname: "127.0.0.1", port: runtime.port, path: "/v1/reminders", method: "POST", headers: {
    authorization: `Bearer ${writer.token}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload), expect: "100-continue",
  } });
  const result = new Promise<number | undefined>((resolve, reject) => {
    req.on("response", res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
  });
  const continuing = new Promise<void>(resolve => req.once("continue", resolve));
  req.flushHeaders();
  try {
    await continuing;
    req.write(payload.slice(0, -1));
    expect((await revoke("agent")).status).toBe(200);
    req.end("}");
    expect(await result).toBe(401);
  } finally { req.destroy(); }
  const store = runtime.store.assistantStore();
  expect(store.reminders()).toHaveLength(1);
  now = scheduled.remindAt;
  const checked = vi.spyOn(runtime.store, "kvGet");
  runtime.assistant.wake();
  await vi.waitFor(() => expect(checked).toHaveBeenCalledWith("dnd"));
  expect(store.reminder(scheduled.reminderId)?.status).toBe("pending");
  expect(notify).not.toHaveBeenCalled();
  runtime.store.kvSet("dnd", "0");
  runtime.assistant.wake();
  await vi.waitFor(() => expect(store.reminder(scheduled.reminderId)).toMatchObject({ attempts: 1, status: "accepted" }));
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining(input.message) }));
});
