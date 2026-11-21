import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentReminderReceipt, AgentReminderRescheduleReceipt } from "@maneki-pet/core";
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
  if (["reminder_read", "reminder_cancel", "reminder_reschedule"].includes(scopes)) expect(res.headers.get("cache-control")).toBe("no-store");
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
async function postDuring(path: string, token: string, body: object, whilePaused: () => Promise<void>): Promise<number | undefined> {
  const payload = JSON.stringify(body);
  const req = request({ hostname: "127.0.0.1", port: runtime.port, path: `/v1${path}`, method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload), expect: "100-continue",
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
    await whilePaused();
    req.end("}");
    return await result;
  } finally { req.destroy(); }
}

it("查询与取消凭证独立签发、证明和撤销，匹配已撤销的创建身份", async () => {
  const name = "manager";
  for (const scopes of ["reminder_read", "reminder_cancel"]) {
    const res = await call("/pair", runtime.rootToken, { name, scopes });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "reminder_creator_not_registered" });
  }
  const creator = await pair(name);
  const legacy = await create(creator.token);
  expect((await revoke(name)).status).toBe(200);
  for (const scopes of ["reminder_read,reminder_cancel", "reminder_read,assistant", "reminder_cancel,reminder_create", "reminder_cancel,reminder_cancel"]) {
    expect((await call("/pair", runtime.rootToken, { name, scopes })).status).toBe(400);
  }
  const reader = await pair(name, "reminder_read"), canceller = await pair(name, "reminder_cancel");
  const challenge = randomBytes(32).toString("base64url");
  const proofs = ["reminderProof", "reminderReadProof", "reminderCancelProof"];
  const cancelInput = { reminderId: legacy.reminderId, version: 1, requestId: "cancel-1" };
  for (const { identity, scope, purpose, field } of [
    { identity: reader, scope: "read", purpose: "reminder-read", field: "reminderReadProof" },
    { identity: canceller, scope: "cancel", purpose: "reminder-cancel", field: "reminderCancelProof" },
  ]) {
    const identityPath = `/reminders/${scope}/identity`;
    const adminPath = `/admin/reminders/${scope}/revoke`;
    const probe = await call(identityPath, identity.token);
    expect(probe.status).toBe(200);
    expect(probe.headers.get("cache-control")).toBe("no-store");
    expect(await probe.json()).toEqual({ clientId: identity.clientId, name });
    expect((await call(adminPath, identity.token, { name })).status).toBe(403);
    expect((await call(identityPath, runtime.rootToken)).status).toBe(403);
    async function health() {
      const headers: Record<string, string> = {};
      for (const item of ["reminder", "reminder-read", "reminder-cancel"]) {
        headers[`x-maneki-${item}-client`] = identity.clientId;
        headers[`x-maneki-${item}-challenge`] = challenge;
      }
      const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/health`, { headers });
      return await res.json() as Record<string, unknown>;
    }
    const result = await health();
    const expected = createHmac("sha256", createHash("sha256").update(identity.token).digest())
      .update(JSON.stringify([`maneki-${purpose}-proof-v1`, identity.clientId, challenge, runtime.instanceId, runtime.port])).digest("hex");
    for (const value of proofs) expect(result[value]).toBe(value === field ? expected : undefined);
    expect((await call("/reminders", identity.token, input)).status).toBe(403);
    expect((await call("/assistant/snapshot", identity.token)).status).toBe(403);
    expect((await call("/ws-ticket", identity.token, {})).status).toBe(403);
    expect((await call("/reminders/pending", identity.token)).status).toBe(scope === "read" ? 200 : 403);
    const cancel = await call("/reminders/cancel", identity.token, cancelInput);
    expect(cancel.status).toBe(scope === "cancel" ? 200 : 403);
    if (scope === "cancel") expect(cancel.headers.get("cache-control")).toBe("no-store");
    expect((await call(adminPath, runtime.rootToken, { name: "not-registered" })).status).toBe(404);
    const revoked = await call(adminPath, runtime.rootToken, { name });
    expect(revoked.status).toBe(200);
    expect(revoked.headers.get("cache-control")).toBe("no-store");
    expect(await revoked.json()).toEqual({ revoked: identity.clientId });
    const count = runtime.store.auditCount();
    expect(await (await call(adminPath, runtime.rootToken, { name })).json()).toEqual({ revoked: identity.clientId });
    expect(runtime.store.auditCount()).toBe(count);
    expect((await health())[field]).toBeUndefined();
    expect((await call(identityPath, identity.token)).status).toBe(401);
    expect((await call("/pair", runtime.rootToken, { name, scopes: `reminder_${scope}` })).status).toBe(409);
  }
  expect((await call("/reminders/pending", creator.token)).status).toBe(401);
});

it("按当前到期时间和 ID 查询自有提醒，准确取消同名目标并在重启后重放回执", async () => {
  const creator = await pair("owner-a");
  const other = await pair("owner-b");
  const sameNameA = await create(creator.token);
  const sameNameB = await create(creator.token, { ...input, requestId: "same-name", afterSeconds: 120 });
  const sameNameC = await create(creator.token, { ...input, requestId: "same-time" });
  const otherReminder = await create(other.token);
  const local = await call("/assistant/mutations", runtime.rootToken, {
    action: "reminder.create", requestId: "desktop", message: input.message, remindAt: now + 60_000,
  });
  expect(local.status).toBe(200);
  const localReminder = await local.json() as { reminderId: string };
  await runtime.stop();
  runtime = await start();
  const reader = await pair("owner-a", "reminder_read"), canceller = await pair("owner-a", "reminder_cancel");
  const otherCanceller = await pair("owner-b", "reminder_cancel");
  const pending = await call("/reminders/pending", reader.token);
  expect(pending.status).toBe(200);
  expect(pending.headers.get("cache-control")).toBe("no-store");
  const earlyIds = [sameNameA.reminderId, sameNameC.reminderId].sort();
  expect(await pending.json()).toEqual({ reminders: [
    ...earlyIds.map(reminderId => ({ reminderId, message: input.message, remindAt: sameNameA.remindAt, version: 1 })),
    { reminderId: sameNameB.reminderId, message: input.message, remindAt: sameNameB.remindAt, version: 1 },
  ] });
  const requestBody = { requestId: "cancel-a", reminderId: sameNameA.reminderId, version: 1 };
  for (const reminderId of [otherReminder.reminderId, localReminder.reminderId, randomUUID()]) {
    const denied = await call("/reminders/cancel", canceller.token, { ...requestBody, reminderId });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "reminder_not_found" });
  }
  expect((await call("/reminders/cancel", otherCanceller.token, requestBody)).status).toBe(404);
  const store = runtime.store.assistantStore(), revision = store.revision();
  const failWrite = vi.spyOn(AssistantStore.prototype, "rememberMutation").mockImplementationOnce(() => { throw new Error("fixture"); });
  expect((await call("/reminders/cancel", canceller.token, requestBody)).status).toBe(500);
  failWrite.mockRestore();
  expect(store.revision()).toBe(revision);
  expect(store.reminder(sameNameA.reminderId)).toBeDefined();
  const receipt = { requestId: requestBody.requestId, reminderId: sameNameA.reminderId, cancelled: true };
  for (const res of await Promise.all([1, 2].map(() => call("/reminders/cancel", canceller.token, requestBody)))) {
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(receipt);
  }
  expect(store.revision()).toBe(revision + 1);
  expect(await create(creator.token)).toEqual(sameNameA);
  expect(store.reminder(sameNameA.reminderId)).toBeUndefined();
  for (const change of [{ reminderId: sameNameB.reminderId }, { version: 2 }]) {
    expect((await call("/reminders/cancel", canceller.token, { ...requestBody, ...change })).status).toBe(409);
  }
  expect((await call("/reminders/cancel", canceller.token, { ...requestBody, requestId: "fresh" })).status).toBe(404);
  await runtime.stop();
  runtime = await start();
  expect(await (await call("/reminders/cancel", canceller.token, requestBody)).json()).toEqual(receipt);
  expect(runtime.store.assistantStore().revision()).toBe(revision + 1);
  expect(await (await call("/reminders/pending", reader.token)).json()).toEqual({ reminders: [
    { reminderId: sameNameC.reminderId, message: input.message, remindAt: sameNameC.remindAt, version: 1 },
    { reminderId: sameNameB.reminderId, message: input.message, remindAt: sameNameB.remindAt, version: 1 },
  ] });
});

it("严格校验取消输入与版本，认领之后即使恢复为 pending 也拒绝取消和改期", async () => {
  const creator = await pair("race");
  const reader = await pair("race", "reminder_read"), canceller = await pair("race", "reminder_cancel");
  const rescheduler = await pair("race", "reminder_reschedule");
  const removal = await create(creator.token);
  const delivery = await create(creator.token, { ...input, requestId: "delivery" });
  const requestBody = { requestId: "cancel-race", reminderId: removal.reminderId, version: 1 };
  for (const change of [{ title: input.message }, { reminderId: input.message }, { reminderId: "00000000-0000-0000-0000-00000000000A" },
    { version: 0 }, { version: "1" }, { version: 1.2 }, { requestId: "invalid id" }]) {
    expect((await call("/reminders/cancel", canceller.token, { ...requestBody, ...change })).status).toBe(400);
  }
  const message = "桌面已经修改";
  expect((await call("/assistant/mutations", runtime.rootToken, {
    action: "reminder.update", id: removal.reminderId, requestId: "desktop-update", message, version: 1,
  })).status).toBe(200);
  expect((await call("/reminders/cancel", canceller.token, requestBody)).status).toBe(409);
  const pending = await (await call("/reminders/pending", reader.token)).json() as { reminders: unknown[] };
  expect(pending.reminders).toContainEqual({ reminderId: removal.reminderId, remindAt: removal.remindAt, message, version: 2 });
  expect((await call("/reminders/cancel", canceller.token, { ...requestBody, version: 2 })).status).toBe(200);

  const store = runtime.store.assistantStore();
  const batch = randomUUID();
  expect(store.transaction(() => store.claim(delivery.reminderId, batch))).toBe(true);
  expect(await (await call("/reminders/pending", reader.token)).json()).toEqual({ reminders: [] });
  const late = { requestId: "cancel-after-claim", reminderId: delivery.reminderId, version: 2 };
  expect((await call("/reminders/cancel", canceller.token, late)).status).toBe(409);
  const lateReschedule = { ...late, afterSeconds: 3600 };
  expect((await call("/reminders/reschedule", rescheduler.token, lateReschedule)).status).toBe(409);
  store.recover();
  expect(store.reminder(delivery.reminderId)).toMatchObject({ status: "pending", attempts: 1, version: 2 });
  expect(await (await call("/reminders/pending", reader.token)).json()).toEqual({ reminders: [] });
  expect((await call("/reminders/cancel", canceller.token, late)).status).toBe(409);
  const recoveredReschedule = await call("/reminders/reschedule", rescheduler.token, lateReschedule);
  expect(recoveredReschedule.status).toBe(409);
  expect(await recoveredReschedule.json()).toEqual({ error: "reminder_not_pending" });
  expect(store.mutation(rescheduler.clientId, lateReschedule.requestId)).toBeUndefined();
  now = delivery.remindAt;
  runtime.assistant.wake();
  await vi.waitFor(() => expect(store.reminder(delivery.reminderId)?.status).toBe("accepted"));
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ id: batch }));
  expect(store.reminder(removal.reminderId)).toBeUndefined();
});

it("损坏的创建回执不证明归属，仍可查询同一身份的其它有效记录", async () => {
  const creator = await pair("damaged");
  const reader = await pair("damaged", "reminder_read"), canceller = await pair("damaged", "reminder_cancel");
  const damaged = await create(creator.token);
  const valid = await create(creator.token, { ...input, requestId: "valid" });
  const db = new DatabaseSync(runtime.store.dbPath);
  try {
    const corrupt = db.prepare("UPDATE assistant_mutations SET result=? WHERE client_id=? AND request_id=?");
    for (const contents of ["{invalid", JSON.stringify({ reminderId: damaged.reminderId }), JSON.stringify({ ...damaged, requestId: "wrong" }),
      JSON.stringify({ ...damaged, remindAt: "out of shape" }), JSON.stringify({ ...damaged, cancelled: true }), Buffer.from(JSON.stringify(damaged))]) {
      corrupt.run(contents, creator.clientId, damaged.requestId);
      expect(await (await call("/reminders/pending", reader.token)).json()).toEqual({ reminders: [
        { reminderId: valid.reminderId, message: input.message, version: 1, remindAt: valid.remindAt },
      ] });
      expect((await call("/reminders/cancel", canceller.token, { requestId: "cancel-damaged", reminderId: damaged.reminderId, version: 1 })).status).toBe(404);
    }
  } finally { db.close(); }
  expect(runtime.store.assistantStore().reminder(damaged.reminderId)).toBeDefined();
});

it("查询最多返回到期时间最早的 200 条自有提醒", async () => {
  const creator = await pair("limit");
  const reader = await pair("limit", "reminder_read");
  const last = await create(creator.token, { ...input, afterSeconds: 360 });
  const store = runtime.store.assistantStore(), lastReminder = store.reminder(last.reminderId)!;
  const expected: string[] = [];
  // 用已落盘的旧版创建回执格式构造容量边界，避开当前的单小时创建配额。
  store.transaction(() => {
    for (let i = 0; i < 200; i++) {
      const requestId = `earlier-${i}`;
      const reminderId = randomUUID();
      const remindAt = lastReminder.remindAt - (200 - i) * 1000;
      store.saveReminder({ ...lastReminder, id: reminderId, remindAt });
      store.rememberMutation(creator.clientId, requestId, "0".repeat(64), { requestId, reminderId, remindAt });
      expected.push(reminderId);
    }
  });
  const res = await call("/reminders/pending", reader.token);
  expect(res.status).toBe(200);
  const { reminders } = await res.json() as { reminders: { reminderId: string }[] };
  expect(reminders.map(({ reminderId }) => reminderId)).toEqual(expected);
});

it("取消凭证在读请求体期间被撤销时，提醒与同名查询权限继续有效", async () => {
  const creator = await pair("revoked-canceller");
  const reader = await pair("revoked-canceller", "reminder_read"), canceller = await pair("revoked-canceller", "reminder_cancel");
  const scheduled = await create(creator.token);
  const body = { requestId: "in-flight-cancel", reminderId: scheduled.reminderId, version: 1 };
  const status = await postDuring("/reminders/cancel", canceller.token, body, async () => {
    expect((await call("/admin/reminders/cancel/revoke", runtime.rootToken, { name: "revoked-canceller" })).status).toBe(200);
  });
  expect(status).toBe(401);
  expect((await call("/reminders/pending", reader.token)).status).toBe(200);
  const store = runtime.store.assistantStore();
  expect(store.mutation(canceller.clientId, body.requestId)).toBeUndefined();
  expect(store.reminder(scheduled.reminderId)).toMatchObject({ attempts: 0, status: "pending" });
  now = scheduled.remindAt;
  runtime.assistant.wake();
  await vi.waitFor(() => expect(store.reminder(scheduled.reminderId)).toMatchObject({ attempts: 1, status: "accepted" }));
  expect(notify).toHaveBeenCalledTimes(1);
});

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
  const status = await postDuring("/reminders", writer.token, { ...input, requestId: "in-flight" }, async () => {
    expect((await revoke("agent")).status).toBe(200);
  });
  expect(status).toBe(401);
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

const rescheduleRoute = "/reminders/reschedule";
const rescheduleScope = "reminder_reschedule";

it("改期独立签发和撤销，仅同名创建登记授权成立", async () => {
  const name = "reschedule-auth";
  const identityRoute = `${rescheduleRoute}/identity`;
  const revokeRoute = "/admin/reminders/reschedule/revoke";
  const signup = { name, scopes: rescheduleScope };
  const prereq = await call("/pair", runtime.rootToken, signup);
  expect(prereq.status).toBe(409);
  expect(await prereq.json()).toEqual({ error: "reminder_creator_not_registered" });
  const creator = await pair(name);
  const original = await create(creator.token);
  const reader = await pair(name, "reminder_read");
  const canceller = await pair(name, "reminder_cancel");
  for (const scopes of [`${rescheduleScope},reminder_read`, `${rescheduleScope},assistant`, `${rescheduleScope},${rescheduleScope}`]) {
    expect((await call("/pair", runtime.rootToken, { name, scopes })).status).toBe(400);
  }
  expect((await revoke(name)).status).toBe(200);
  const rescheduler = await pair(name, rescheduleScope);
  const args = { requestId: "reschedule-auth", reminderId: original.reminderId, version: 1, afterSeconds: 3600 };
  const probe = await call(identityRoute, rescheduler.token);
  expect(probe.status).toBe(200);
  expect(probe.headers.get("cache-control")).toBe("no-store");
  expect(await probe.json()).toEqual({ clientId: rescheduler.clientId, name });
  for (const token of [reader.token, canceller.token, runtime.rootToken]) {
    expect((await call(identityRoute, token)).status).toBe(403);
    expect((await call(rescheduleRoute, token, args)).status).toBe(403);
  }
  for (const [route, body] of [
    ["/reminders/pending"], ["/reminders", input], ["/reminders/cancel", args],
    ["/assistant/snapshot"], ["/ws-ticket", {}], [revokeRoute, { name }],
  ] as const) {
    expect((await call(route, rescheduler.token, body)).status).toBe(403);
  }
  const nonce = randomBytes(32).toString("base64url");
  const headers: Record<string, string> = {};
  for (const purpose of ["reminder", "reminder-read", "reminder-cancel", "reminder-reschedule"]) {
    headers[`x-maneki-${purpose}-client`] = rescheduler.clientId;
    headers[`x-maneki-${purpose}-challenge`] = nonce;
  }
  const proof = await fetch(`http://127.0.0.1:${runtime.port}/v1/health`, { headers });
  expect(proof.headers.get("cache-control")).toBe("no-store");
  const expectedProof = createHmac("sha256", createHash("sha256").update(rescheduler.token).digest())
    .update(JSON.stringify(["maneki-reminder-reschedule-proof-v1", rescheduler.clientId, nonce, runtime.instanceId, runtime.port])).digest("hex");
  const health = await proof.json() as Record<string, unknown>;
  expect(health.reminderRescheduleProof).toBe(expectedProof);
  for (const field of ["reminderProof", "reminderReadProof", "reminderCancelProof"]) {
    expect(health[field]).toBeUndefined();
  }
  const res = await call(rescheduleRoute, rescheduler.token, args);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ requestId: args.requestId, reminderId: original.reminderId, remindAt: now + 3_600_000, version: 2 });

  const paused = await postDuring(rescheduleRoute, rescheduler.token, { ...args, requestId: "revoking", version: 2 }, async () => {
    const revoked = await call(revokeRoute, runtime.rootToken, { name });
    expect(revoked.status).toBe(200);
    expect(revoked.headers.get("cache-control")).toBe("no-store");
    expect(await revoked.json()).toEqual({ revoked: rescheduler.clientId });
    const count = runtime.store.auditCount();
    expect(await (await call(revokeRoute, runtime.rootToken, { name })).json()).toEqual({ revoked: rescheduler.clientId });
    expect(runtime.store.auditCount()).toBe(count);
  });
  expect(paused).toBe(401);
  expect((await call(identityRoute, rescheduler.token)).status).toBe(401);
  expect((await call(rescheduleRoute, rescheduler.token, args)).status).toBe(401);
  const healthAfter = await fetch(`http://127.0.0.1:${runtime.port}/v1/health`, { headers });
  expect((await healthAfter.json() as Record<string, unknown>).reminderRescheduleProof).toBeUndefined();
  expect((await call("/pair", runtime.rootToken, signup)).status).toBe(409);
  expect((await call("/reminders/cancel/identity", canceller.token)).status).toBe(200);
  expect(await (await call("/reminders/pending", reader.token)).json()).toEqual({ reminders: [
    { reminderId: original.reminderId, message: input.message, remindAt: now + 3_600_000, version: 2 },
  ] });
});

it("只改原提醒的到期时间和版本，跨后续改期、取消和重启重放首次回执", async () => {
  const name = "reschedule-replay";
  const creator = await pair(name);
  const original = await create(creator.token);
  const rescheduler = await pair(name, rescheduleScope);
  const canceller = await pair(name, "reminder_cancel");
  const reader = await pair(name, "reminder_read");
  const sameTitle = await create(creator.token, { ...input, requestId: "same-title", afterSeconds: 180 });
  const store = runtime.store.assistantStore();
  const reminder = store.reminder(original.reminderId);
  const rev = store.revision();
  const args = { requestId: input.requestId, reminderId: original.reminderId, version: 1, afterSeconds: 3600 };
  const receipt = { requestId: args.requestId, reminderId: args.reminderId, remindAt: now + 3_600_000, version: 2 };
  for (const res of await Promise.all([1, 2].map(() => call(rescheduleRoute, rescheduler.token, args)))) {
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(receipt);
  }
  expect(store.revision()).toBe(rev + 1);
  expect(store.reminder(args.reminderId)).toEqual({ ...reminder, remindAt: receipt.remindAt, version: 2 });
  expect(await create(creator.token)).toEqual(original);
  expect(await (await call("/reminders/pending", reader.token)).json()).toEqual({ reminders: [
    { reminderId: sameTitle.reminderId, message: input.message, remindAt: sameTitle.remindAt, version: 1 },
    { reminderId: original.reminderId, message: input.message, remindAt: receipt.remindAt, version: 2 },
  ] });
  for (const change of [{ reminderId: sameTitle.reminderId }, { version: 2 }, { afterSeconds: 3599 }]) {
    const conflict = await call(rescheduleRoute, rescheduler.token, { ...args, ...change });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "request_id_conflict" });
  }
  expect((await call("/reminders/cancel", canceller.token, { requestId: "first-cancel", reminderId: args.reminderId, version: 1 })).status).toBe(409);
  now += 1000;
  const second = await call(rescheduleRoute, rescheduler.token, { ...args, requestId: "second-date", version: 2 });
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual({ ...receipt, requestId: "second-date", remindAt: now + 3_600_000, version: 3 });
  expect(await (await call(rescheduleRoute, rescheduler.token, args)).json()).toEqual(receipt);
  expect((await call("/reminders/cancel", canceller.token, { requestId: "first-cancel", reminderId: args.reminderId, version: 3 })).status).toBe(200);
  expect(await (await call(rescheduleRoute, rescheduler.token, args)).json()).toEqual(receipt);
  const fresh = await call(rescheduleRoute, rescheduler.token, { ...args, requestId: "now-missing", version: 3 });
  expect(fresh.status).toBe(404);
  expect(store.revision()).toBe(rev + 3);
  await runtime.stop();
  runtime = await start();
  expect(await (await call(rescheduleRoute, rescheduler.token, args)).json()).toEqual(receipt);
  expect(runtime.store.assistantStore().revision()).toBe(rev + 3);
  expect(runtime.store.assistantStore().reminders().map(row => row.id)).toEqual([sameTitle.reminderId]);
});

it("调度器跳过旧到期时间并在新到期时间只投递一次", async () => {
  const name = "reschedule-dispatch";
  const creator = await pair(name);
  const rescheduler = await pair(name, rescheduleScope);
  const original = await create(creator.token, { ...input, afterSeconds: 30 });
  const store = runtime.store.assistantStore();
  const due = vi.spyOn(AssistantStore.prototype, "due");
  runtime.assistant.wake();
  await vi.waitFor(() => expect(due).toHaveBeenCalledWith(now));
  now += 1000;
  const args = { requestId: "change-time", reminderId: original.reminderId, version: 1, afterSeconds: 60 };
  const res = await call(rescheduleRoute, rescheduler.token, args);
  expect(res.status).toBe(200);
  const updated = await res.json() as AgentReminderRescheduleReceipt;
  expect(updated.remindAt).toBe(now + 60_000);
  await vi.waitFor(() => expect(due).toHaveBeenCalledWith(now));

  now = original.remindAt;
  runtime.assistant.wake();
  await vi.waitFor(() => expect(due).toHaveBeenCalledWith(original.remindAt));
  expect(store.reminder(original.reminderId)).toMatchObject({ attempts: 0, status: "pending" });
  expect(notify).not.toHaveBeenCalled();

  now = updated.remindAt;
  runtime.assistant.wake();
  await vi.waitFor(() => expect(store.reminder(original.reminderId)).toMatchObject({ attempts: 1, status: "accepted" }));
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining(input.message) }));
  expect(await (await call(rescheduleRoute, rescheduler.token, args)).json()).toEqual(updated);
  now++;
  runtime.assistant.wake();
  await vi.waitFor(() => expect(due).toHaveBeenCalledWith(updated.remindAt + 1));
  expect(notify).toHaveBeenCalledTimes(1);
});

it("拒绝越权、非法参数和无法递增的版本，同版本取消与改期最多一项成功", async () => {
  const name = "reschedule-race";
  const creator = await pair(name);
  const rescheduler = await pair(name, rescheduleScope);
  const canceller = await pair(name, "reminder_cancel");
  const other = await pair("other-race");
  const reminder = await create(creator.token);
  const otherReminder = await create(other.token);
  const desktop = await call("/assistant/mutations", runtime.rootToken, {
    action: "reminder.create", requestId: "desktop-race", message: input.message, remindAt: now + 60_000,
  });
  expect(desktop.status).toBe(200);
  const local = await desktop.json() as { reminderId: string };
  const args = { requestId: "reschedule-race", reminderId: reminder.reminderId, version: 1, afterSeconds: 60 };
  for (const invalid of [{ message: input.message }, { reminderId: input.message },
    { reminderId: "00000000-0000-0000-0000-00000000000A" }, { requestId: "x+" }, { version: 0 }, { version: 1.5 },
    { version: "1" }, { afterSeconds: 0 }, { afterSeconds: 31_622_401 }, { afterSeconds: 1.5 }, { afterSeconds: "1" }]) {
    expect((await call(rescheduleRoute, rescheduler.token, { ...args, ...invalid })).status).toBe(400);
  }
  for (const reminderId of [otherReminder.reminderId, local.reminderId, randomUUID()]) {
    const denied = await call(rescheduleRoute, rescheduler.token, { ...args, reminderId });
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ error: "reminder_not_found" });
  }
  const store = runtime.store.assistantStore();
  const { afterSeconds, ...cancelArgs } = args;
  const concurrent = await Promise.all([
    call(rescheduleRoute, rescheduler.token, args),
    call("/reminders/cancel", canceller.token, cancelArgs),
  ]);
  expect(concurrent.filter(response => response.status === 200)).toHaveLength(1);
  if (concurrent[0]!.status === 200) {
    expect(concurrent[1]!.status).toBe(409);
    expect(store.reminder(args.reminderId)).toMatchObject({ version: 2, remindAt: now + afterSeconds * 1000 });
  } else {
    expect(concurrent[0]!.status).toBe(404);
    expect(store.reminder(args.reminderId)).toBeUndefined();
  }
  const exhausted = await create(creator.token, { ...input, requestId: "exhausted-version" });
  store.saveReminder({ ...store.reminder(exhausted.reminderId)!, version: Number.MAX_SAFE_INTEGER });
  const rejected = await call(rescheduleRoute, rescheduler.token, { ...args,
    requestId: "exhausted-version", reminderId: exhausted.reminderId, version: Number.MAX_SAFE_INTEGER,
  });
  expect(rejected.status).toBe(409);
  expect(await rejected.json()).toEqual({ error: "reminder_version_exhausted" });
  expect(store.mutation(rescheduler.clientId, "exhausted-version")).toBeUndefined();
  expect(store.reminder(exhausted.reminderId)).toMatchObject({ version: Number.MAX_SAFE_INTEGER, remindAt: exhausted.remindAt });
});

it("按改期身份和 UTC 整点小时独立记账，失败回滚，重放及回拨不多发额度", async () => {
  const name = "reschedule-quota";
  const creator = await pair(name);
  const rescheduler = await pair(name, rescheduleScope);
  const otherCreator = await pair("reschedule-quota-other");
  const other = await pair("reschedule-quota-other", rescheduleScope);
  now = Date.parse("2026-11-21T10:59:59.999Z");
  const original = await create(creator.token, { ...input, afterSeconds: 86_400 });
  const otherReminder = await create(otherCreator.token, { ...input, afterSeconds: 86_400 });
  const store = runtime.store.assistantStore();
  const rev = store.revision();
  const quotaKey = `reminderRescheduleQuota.${rescheduler.clientId}`;
  const args = { requestId: "change-0", reminderId: original.reminderId, version: 1, afterSeconds: 86_399 };
  const failedWrite = vi.spyOn(AssistantStore.prototype, "rememberMutation")
    .mockImplementationOnce(() => { throw new Error("fixture-write-failed"); });
  expect((await call(rescheduleRoute, rescheduler.token, args)).status).toBe(500);
  failedWrite.mockRestore();
  expect(store.get(quotaKey)).toBeNull();
  expect(store.revision()).toBe(rev);
  expect(store.reminder(original.reminderId)).toMatchObject({ version: 1, remindAt: original.remindAt });
  expect(store.mutation(rescheduler.clientId, args.requestId)).toBeUndefined();
  const receipt = { requestId: args.requestId, reminderId: args.reminderId, version: 2, remindAt: now + 86_399_000 };
  for (let change = 0; change < 30; change++) {
    const res = await call(rescheduleRoute, rescheduler.token, { ...args, requestId: `change-${change}`, version: change + 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...receipt, requestId: `change-${change}`, version: change + 2 });
  }
  const overflow = { ...args, requestId: "overflow", version: 31 };
  const limited = await call(rescheduleRoute, rescheduler.token, overflow);
  expect(limited.status).toBe(429);
  expect(await limited.json()).toEqual({ error: "reminder_reschedule_quota" });
  expect(store.revision()).toBe(rev + 30);
  await runtime.stop();
  runtime = await start();
  expect(await (await call(rescheduleRoute, rescheduler.token, args)).json()).toEqual(receipt);
  expect((await call(rescheduleRoute, rescheduler.token, overflow)).status).toBe(429);
  expect((await call(rescheduleRoute, rescheduler.token, { ...args, afterSeconds: 1 })).status).toBe(409);
  expect((await call(rescheduleRoute, other.token, { ...args, reminderId: otherReminder.reminderId })).status).toBe(200);
  expect(await create(creator.token, { ...input, requestId: "creator-can-still-create", afterSeconds: 86_400 }))
    .toMatchObject({ requestId: "creator-can-still-create" });
  now -= 3_600_000;
  expect((await call(rescheduleRoute, rescheduler.token, overflow)).status).toBe(429);
  now = Date.parse("2026-11-21T11:00:00.000Z");
  const nextHour = await call(rescheduleRoute, rescheduler.token, overflow);
  expect(nextHour.status).toBe(200);
  const nextHourReceipt = { requestId: "overflow", reminderId: args.reminderId, version: 32, remindAt: now + 86_399_000 };
  expect(await nextHour.json()).toEqual(nextHourReceipt);
  now--;
  const afterRollback = { ...args, requestId: "after-rollback", version: 32 };
  const rollbackDenied = await call(rescheduleRoute, rescheduler.token, afterRollback);
  expect(rollbackDenied.status).toBe(429);
  expect(await rollbackDenied.json()).toEqual({ error: "reminder_reschedule_quota" });
  expect(await (await call(rescheduleRoute, rescheduler.token, overflow)).json()).toEqual(nextHourReceipt);
  now++;
  expect((await call(rescheduleRoute, rescheduler.token, afterRollback)).status).toBe(200);
});
