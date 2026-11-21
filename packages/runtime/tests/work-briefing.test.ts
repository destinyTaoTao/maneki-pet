import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clientCredential } from "../src/desktop-credential.js";
import type { StartedRuntime } from "../src/runtime.js";
import { startFetchCompatibleRuntime } from "./fetch-compatible-runtime.js";
import { defaultAssistantSettings } from "../src/assistant-settings.js";
import { AssistantStore } from "../src/assistant-store.js";

let directory: string;
let runtime: StartedRuntime;
const log = vi.fn(), provider = vi.fn(), notify = vi.fn();
const memory = { pair: vi.fn(), save: vi.fn(), recall: vi.fn(), invalidate: vi.fn(), stop: vi.fn(async () => {}) };
beforeEach(async () => {
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), "maneki-work-briefing-"));
  runtime = await startFetchCompatibleRuntime({ configDir: directory, log, chatProvider: provider, notifier: { notify }, assistantMemory: memory });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await runtime.stop();
  rmSync(directory, { recursive: true, force: true });
});

function call(path: string, token?: string, body?: unknown) {
  return fetch(`http://127.0.0.1:${runtime.port}/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function pair(name: string, scopes: string) {
  const response = await call("/pair", runtime.rootToken, { name, scopes });
  expect(response.status).toBe(200);
  return await response.json() as { clientId: string; token: string };
}

it("只向具名独立 scope 提供简报与域隔离的证明，撤销仅失效对应身份", async () => {
  const a = await pair("host-a", "briefing_read"), b = await pair("host-b", "briefing_read");
  const challenge = randomBytes(32).toString("base64url");
  async function proof(clientId: string, nonce = challenge) {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/v1/health`, { headers: {
      "x-maneki-briefing-client": clientId, "x-maneki-briefing-challenge": nonce,
      "x-maneki-expression-client": clientId, "x-maneki-expression-challenge": nonce,
    } });
    return await response.json() as { briefingProof?: string; expressionProof?: string };
  }
  const expected = createHmac("sha256", createHash("sha256").update(a.token).digest())
    .update(JSON.stringify(["maneki-briefing-proof-v1", a.clientId, challenge, runtime.instanceId, runtime.port])).digest("hex");
  const health = await proof(a.clientId);
  expect(health.briefingProof).toBe(expected);
  expect(health.expressionProof).toBeUndefined();
  expect((await proof(a.clientId, "short")).briefingProof).toBeUndefined();
  expect((await call("/briefing")).status).toBe(401);
  expect((await call("/briefing", runtime.rootToken)).status).toBe(403);
  for (const scope of ["express", "assistant,settings", "settings", "notify", "tasks", "speech_host"]) {
    const old = await pair(`old-${scope}`, scope);
    expect((await call("/briefing", old.token)).status).toBe(403);
    expect((await proof(old.clientId)).briefingProof).toBeUndefined();
  }
  for (const [name, scopes] of [["mixed", "express,briefing_read"], [" ", "briefing_read"], ["Case", "briefing_read"], ["x".repeat(49), "briefing_read"]]) {
    expect((await call("/pair", runtime.rootToken, { name, scopes })).status).toBe(400);
  }
  for (const path of ["/assistant/history", "/assistant/settings", "/assistant/snapshot", "/clients", "/dnd", "/expressions/state", "/limits", "/tasks/any"]) {
    expect((await call(path, a.token)).status).toBe(403);
  }
  for (const path of ["/pair", "/ws-ticket", "/observations/sessions", "/tasks", "/shutdown", "/briefing"]) {
    expect((await call(path, a.token, {})).status).toBe(403);
  }
  expect((await call(`/clients/${a.clientId}/revoke`, runtime.rootToken, {})).status).toBe(200);
  expect((await call("/briefing", a.token)).status).toBe(401);
  expect((await proof(a.clientId)).briefingProof).toBeUndefined();
  expect((await call("/briefing", b.token)).status).toBe(200);
});

it("并发配对具名简报只签发一次，撤销按服务端 scope 与名称匹配，其他客户端同名仍可用", async () => {
  const grants = { name: "shared-name", scopes: "briefing_read" };
  const sameName = await pair(grants.name, "express");
  const replies = await Promise.all([call("/pair", runtime.rootToken, grants), call("/pair", runtime.rootToken, grants)]);
  expect(replies.map(reply => reply.status).sort()).toEqual([200, 409]);
  const reader = await replies.find(reply => reply.ok)!.json() as { token: string; clientId: string };
  expect(await (await call("/briefing/identity", reader.token)).json()).toEqual({ name: grants.name, clientId: reader.clientId });
  const revoke = (name: string, token: string) => call("/admin/briefing/revoke", token, { name });
  expect((await revoke(grants.name, reader.token)).status).toBe(403);
  expect((await revoke(grants.name, sameName.token)).status).toBe(403);
  expect((await revoke("missing", runtime.rootToken)).status).toBe(404);
  expect((await revoke("invalid name", runtime.rootToken)).status).toBe(400);
  expect(await (await revoke(grants.name, runtime.rootToken)).json()).toEqual({ revoked: reader.clientId });
  const audits = runtime.store.auditCount();
  expect(await (await revoke(grants.name, runtime.rootToken)).json()).toEqual({ revoked: reader.clientId });
  expect(runtime.store.auditCount()).toBe(audits);
  expect((await call("/briefing", reader.token)).status).toBe(401);
  expect((await call("/pair", runtime.rootToken, grants)).status).toBe(409);
  expect((await call("/expressions/state", sameName.token)).status).toBe(200);
});

it("按个人时区选择到期未完成事项，精确投影并限制数量，读取不产生事件或个人写入", async () => {
  const reader = await pair("host", "briefing_read"), observer = await pair("dsh-web", "express");
  const store = runtime.store.assistantStore(), settings = defaultAssistantSettings();
  const now = Date.parse("2026-11-21T16:01:00Z");
  vi.spyOn(Date, "now").mockReturnValue(now);
  settings.timeZone = "Asia/Shanghai";
  settings.persona = "private-test-persona";
  store.set("settings", JSON.stringify(settings));
  store.append("user", "private-test-history");
  function todo(id: string, title: string, dueDate: string | null, completed = false) {
    store.saveTodo({ id, title, dueDate, completed, notes: "private-test-notes", version: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01" });
  }
  todo("a", "未定期", null);
  todo("b", "已完成", "2026-11-21", true);
  todo("c", "明天", "2026-11-23");
  todo("e", "到期二", "2026-11-22");
  todo("d", "到期一", "2026-11-22");
  todo("f", "逾期", "2026-11-21");
  const sourceId = "00000000-0000-4000-8000-000000000001";
  const row = { sessionId: "shared-session", projectName: "工程", phase: "waiting_input", sequence: 1, observedAt: 1000 };
  const report = { sourceId, profileId: "web", reportSequence: 1, connected: true, truncated: false, sessions: [row] };
  expect((await call("/observations/sessions", observer.token, report)).status).toBe(202);
  const feed = vi.fn();
  const unsubscribe = runtime.feed.subscribe(feed);
  try {
    const audit = runtime.store.auditCount(), revision = store.revision(), messages = store.messageCount();
    const result = await call("/briefing", reader.token);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const rendered = await result.text();
    expect(JSON.parse(rendered)).toEqual({
      date: "2026-11-22", timeZone: "Asia/Shanghai",
      todos: [{ title: "逾期", dueDate: "2026-11-21" }, { title: "到期一", dueDate: "2026-11-22" }, { title: "到期二", dueDate: "2026-11-22" }],
      moreTodos: false, onlineSources: 1, offlineSources: 0, partialSessions: false,
      waiting: [{ clientId: observer.clientId, profileId: "web", sourceId, sessionId: row.sessionId, projectName: row.projectName, observedAt: row.observedAt }],
    });
    expect(store.messageCount()).toBe(messages);
    expect(store.revision()).toBe(revision);
    expect(runtime.store.auditCount()).toBe(audit);
    expect(feed).not.toHaveBeenCalled();
    for (const fn of [provider, notify, memory.recall, memory.save, memory.pair]) expect(fn).not.toHaveBeenCalled();
    for (const sensitive of [reader.token, runtime.rootToken, row.sessionId, "到期一", "private-test"]) {
      expect(JSON.stringify(log.mock.calls)).not.toContain(sensitive);
    }
    settings.timeZone = "America/New_York";
    store.set("settings", JSON.stringify(settings));
    expect(await (await call("/briefing", reader.token)).json()).toMatchObject({
      date: "2026-11-21", todos: [{ title: "逾期", dueDate: "2026-11-21" }],
    });
    for (let i = 0; i < 8; i++) todo(`old-${i}`, `最早 ${i}`, "2020-01-01");
    expect(await (await call("/briefing", reader.token)).json()).toMatchObject({
      moreTodos: true, todos: Array.from({ length: 8 }, (_, i) => ({ title: `最早 ${i}`, dueDate: "2020-01-01" })),
    });
  } finally { unsubscribe(); }
});

it("复用探针校验保存的 ID，不读取个人正文，已撤销的文件不会被自动重配", async () => {
  const credential = (allow: boolean) => clientCredential(directory, runtime.port, "fixture-brief", "fixture", "briefing_read", allow);
  await expect(credential(false)).rejects.toMatchObject({ code: "pairing_required" });
  const reader = await credential(true);
  const dueTodos = vi.spyOn(AssistantStore.prototype, "dueTodos");
  expect(await credential(false)).toEqual(reader);
  expect(dueTodos).not.toHaveBeenCalled();
  const path = join(directory, "fixture-brief.json"), saved = readFileSync(path, "utf8");
  const other = await pair("other", "briefing_read");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(saved), clientId: other.clientId }));
  await expect(credential(true)).rejects.toMatchObject({ code: "credential_rejected" });
  writeFileSync(path, JSON.stringify({ ...JSON.parse(saved), ...other }));
  await expect(credential(true)).rejects.toMatchObject({ code: "credential_rejected" });
  writeFileSync(path, saved);
  expect((await call(`/clients/${reader.clientId}/revoke`, runtime.rootToken, {})).status).toBe(200);
  const clients = runtime.store.listClients().length;
  await expect(credential(true)).rejects.toMatchObject({ code: "credential_rejected" });
  expect(runtime.store.listClients()).toHaveLength(clients);
});
