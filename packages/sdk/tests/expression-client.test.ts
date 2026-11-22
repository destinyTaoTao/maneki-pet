import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type RequestListener } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createBriefingClient, createExpressionClient, createRecurringReminderClient, createRecurringReminderRescheduleClient, createReminderCancelClient,
  createReminderClient, createReminderReadClient, createReminderRescheduleClient, type AgentReminderCancelInput,
  type AgentReminderInput, type AgentReminderRescheduleInput, type DailyReminderCancelInput, type DailyReminderInput,
  type DailyReminderRescheduleInput, type ReminderClientOptions,
} from "../src/index.js";

let dir: string;
let tokenFile: string;
const credential = { instanceId: "rt-test12345678", clientId: "client-aa0000000001", token: "" };
let cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "maneki-sdk-"));
  tokenFile = join(dir, "client-token");
  credential.token = randomBytes(32).toString("base64url");
  writeFileSync(tokenFile, JSON.stringify(credential));
});
afterEach(async () => {
  for (const close of cleanup) await close();
  cleanup = [];
  rmSync(dir, { recursive: true, force: true });
});

const proofFields = {
  expression: "expressionProof", briefing: "briefingProof", reminder: "reminderProof",
  "reminder-read": "reminderReadProof", "reminder-cancel": "reminderCancelProof",
  "reminder-reschedule": "reminderRescheduleProof", "reminder-recurring": "recurringReminderProof",
  "reminder-recurring-reschedule": "recurringReminderRescheduleProof",
} as const;
type Capability = keyof typeof proofFields;

function healthProof(req: IncomingMessage, capability: Capability = "expression", domain = capability): Record<string, unknown> {
  const key = createHash("sha256").update(credential.token).digest();
  const proof = createHmac("sha256", key).update(JSON.stringify([
    `maneki-${domain}-proof-v1`, req.headers[`x-maneki-${capability}-client`],
    req.headers[`x-maneki-${capability}-challenge`], credential.instanceId, req.socket.localPort,
  ])).digest("hex");
  return { protocolVersion: 1, instanceId: credential.instanceId, [proofFields[capability]]: proof };
}

async function serve(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  return `http://127.0.0.1:${address.port}`;
}

async function serveVerified(listener: RequestListener, capability: Capability = "expression"): Promise<string> {
  const verified = new WeakSet<Socket>();
  return serve((req, res) => {
    if (req.url === "/v1/health" && !req.headers.authorization) {
      verified.add(req.socket);
      res.end(JSON.stringify(healthProof(req, capability)));
    } else if (verified.has(req.socket) && req.headers.authorization === `Bearer ${credential.token}`) {
      listener(req, res);
    } else {
      res.writeHead(403).end();
    }
  });
}

it("仅连接显式 IPv4 回环端口，拒绝 root 和包含路径信息的凭证错误", () => {
  for (const baseUrl of ["http://localhost:3000", "http://127.1:3000", "http://user@127.0.0.1:3000",
    "http://127.0.0.1:3000/path", "http://127.0.0.1:0", "http://127.0.0.1:99999"]) {
    expect(() => createExpressionClient({ baseUrl, tokenFile })).toThrow("127.0.0.1:<port>");
  }
  const baseUrl = "http://127.0.0.1:18100";
  const root = join(dir, "root-token");
  writeFileSync(root, randomBytes(32).toString("base64url"));
  const legacy = join(dir, "legacy-token");
  writeFileSync(legacy, credential.token);
  for (const file of [root, legacy, join(dir, "private-file-path")]) {
    expect(() => createExpressionClient({ baseUrl, tokenFile: file })).toThrow(/^需要可读的已配对 express 凭证文件$/);
  }
});

it.each(["旧版本", "错误证明", "实例不匹配", "连接关闭"])("%s 的健康响应不会触发带凭证的请求", async (reason) => {
  const methods: string[] = [];
  let sawAuthorization = false;
  const baseUrl = await serve((req, res) => {
    methods.push(`${req.method} ${req.url}`);
    sawAuthorization ||= req.headers.authorization !== undefined;
    const proof = healthProof(req);
    if (reason === "连接关闭") res.setHeader("connection", "close");
    res.end(JSON.stringify({
      ...proof,
      ...(reason === "旧版本" ? { expressionProof: undefined } : {}),
      ...(reason === "错误证明" ? { expressionProof: "0".repeat(64) } : {}),
      ...(reason === "实例不匹配" ? { instanceId: "rt-000000000000" } : {}),
    }));
  });
  const client = createExpressionClient({ baseUrl, tokenFile });
  await expect(client.setState("working")).rejects.toThrow();
  expect(methods).toEqual(["GET /v1/health"]);
  expect(sawAuthorization).toBe(false);
});

it("不跟随重定向，不转发凭证或响应正文", async () => {
  let redirected = false;
  const other = await serve((_req, res) => { redirected = true; res.end(); });
  const baseUrl = await serve((_req, res) => {
    res.writeHead(307, { location: other });
    res.end("private response");
  });
  const client = createExpressionClient({ baseUrl, tokenFile });
  await expect(client.setState("working")).rejects.toThrow(/^Runtime 拒绝状态请求 \(HTTP 307\)$/);
  expect(redirected).toBe(false);
});

it("接受 sleeping 快照，拒绝超限和无效正文", async () => {
  let body = '{"state":"sleeping"}';
  const baseUrl = await serveVerified((_req, res) => res.end(body));
  const client = createExpressionClient({ baseUrl, tokenFile });
  expect(await client.getState()).toBe("sleeping");
  body = " ".repeat(1025);
  await expect(client.getState()).rejects.toThrow("响应过大");
  body = '{"state":"private-response"}';
  await expect(client.getState()).rejects.toThrow(/^Runtime 状态响应格式无效$/);
});

it("等待正文时仍可取消，响应超时受限", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const baseUrl = await serveVerified((_req, res) => {
    res.writeHead(200);
    res.write("{");
    markStarted();
  });
  const client = createExpressionClient({ baseUrl, tokenFile });
  const controller = new AbortController();
  const pending = client.getState(controller.signal);
  await started;
  controller.abort(new Error("private abort reason"));
  await expect(pending).rejects.toThrow(/^状态请求已取消$/);
  await expect(client.getState()).rejects.toThrow(/^Runtime 状态请求超时$/);
});

it.each(["旧服务", "错误能力的 HMAC", "证明后断开"])("简报校验遇到%s时，凭证不会离开客户端", async (reason) => {
  const requests: Array<[string | undefined, string | undefined]> = [];
  const baseUrl = await serve((req, res) => {
    requests.push([req.url, req.headers.authorization]);
    expect(req.headers["x-maneki-briefing-client"]).toBe(credential.clientId);
    expect(req.headers["x-maneki-expression-challenge"]).toBeUndefined();
    if (reason === "证明后断开") res.setHeader("connection", "close");
    const body = reason === "旧服务" ? healthProof(req) :
      healthProof(req, "briefing", reason === "错误能力的 HMAC" ? "expression" : "briefing");
    res.end(JSON.stringify(body));
  });
  await expect(createBriefingClient({ baseUrl, tokenFile }).getBriefing()).rejects.toThrow("无法验证 Runtime 的简报身份");
  expect(requests).toEqual([["/v1/health", undefined]]);
});

const due = { title: "合成待办", dueDate: "2026-11-21" };
const waiting = { clientId: "client-bb0000000001", profileId: "web", sourceId: "00000000-0000-0000-0000-000000000001",
  projectName: "合成项目", sessionId: "work-1", observedAt: 123 };
const briefing = { date: due.dueDate, timeZone: "Asia/Shanghai", todos: [due], moreTodos: false,
  waiting: [waiting], onlineSources: 1, offlineSources: 0, partialSessions: false };

it("在已验证的连接读取简报，按字段、条数、日期、投影和来源上限检查成功响应", async () => {
  let body = JSON.stringify(briefing);
  const baseUrl = await serveVerified((req, res) => {
    expect([req.method, req.url]).toEqual(["GET", "/v1/briefing"]);
    res.end(body);
  }, "briefing");
  const client = createBriefingClient({ baseUrl, tokenFile });
  expect(Object.keys(client)).toEqual(["getBriefing"]);
  expect(await client.getBriefing()).toEqual(briefing);
  for (const invalid of [
    { date: "2026-02-30" }, { timeZone: "not a time zone" }, { private: "private-response" }, { moreTodos: 0 },
    { todos: [{ ...due, notes: "private-response" }] }, { todos: Array(9).fill(due) },
    { todos: [{ ...due, title: "x".repeat(201) }] }, { todos: [{ ...due, dueDate: "2026-11-22" }] },
    { todos: [due, { ...due, dueDate: "2026-11-20" }] }, { moreTodos: true },
    { waiting: Array(9).fill(waiting) }, { waiting: [{ ...waiting, phase: "working" }] },
    { waiting: [{ ...waiting, projectName: "private/path" }] }, { waiting: [{ ...waiting, sessionId: "a".repeat(161) }] },
    { waiting: [{ ...waiting, clientId: "root" }] }, { waiting: [{ ...waiting, sourceId: "" }] }, { waiting: [{ ...waiting, profileId: "bad/id" }] },
    { waiting: [{ ...waiting, observedAt: 0.1 }] }, { waiting: [waiting, { ...waiting, observedAt: 124 }] },
    { waiting: [waiting, waiting] }, { waiting: [waiting, { ...waiting, clientId: "client-bb0000000002" }] },
    { onlineSources: 0 }, { offlineSources: 64 }, { offlineSources: -1 }, { partialSessions: null },
  ]) {
    body = JSON.stringify({ ...briefing, ...invalid });
    await expect(client.getBriefing()).rejects.toThrow(/^Runtime 简报响应格式无效$/);
  }
  body = JSON.stringify(briefing);
  body += " ".repeat(32 * 1024 - Buffer.byteLength(body));
  expect(Buffer.byteLength(body)).toBe(32 * 1024);
  expect(await client.getBriefing()).toEqual(briefing);
  body += " ";
  await expect(client.getBriefing()).rejects.toThrow(/^Runtime 响应过大$/);
});

it("简报请求在授权撤销、取消和等待正文超时时返回脱敏错误", async () => {
  let deny = true;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const baseUrl = await serveVerified((_req, res) => {
    if (deny) {
      res.writeHead(403).end("private-response");
    } else {
      res.write("{");
      markStarted();
    }
  }, "briefing");
  const client = createBriefingClient({ baseUrl, tokenFile });
  await expect(client.getBriefing()).rejects.toThrow(/^Runtime 拒绝简报请求 \(HTTP 403\)$/);
  deny = false;
  const controller = new AbortController();
  const pending = client.getBriefing(controller.signal);
  await started;
  controller.abort(new Error("private reason"));
  await expect(pending).rejects.toThrow(/^简报请求已取消$/);
  await expect(client.getBriefing()).rejects.toThrow(/^Runtime 简报请求超时$/);
});

const reminderMessage = "提醒🐈\tA<&>\r\nB";
const reminder = { requestId: "task-1", afterSeconds: 60, message: "  " + reminderMessage + "  " };
const receipt = { requestId: reminder.requestId, reminderId: "ab000000-0000-4000-a000-000000000001", remindAt: 1700000060000 };

it("发送前校验提醒的严格字段、秒数和 UTF-16 文本长度", async () => {
  let calls = 0;
  const baseUrl = await serve((_req, res) => { calls++; res.end(); });
  const client = createReminderClient({ baseUrl, tokenFile });
  expect(Object.keys(client)).toEqual(["createReminder"]);
  for (const invalid of [null, [], {}, { ...reminder, token: "private" }, { ...reminder, requestId: "bad/id" },
    { ...reminder, requestId: "x".repeat(81) }, { ...reminder, afterSeconds: 0 }, { ...reminder, afterSeconds: 31622401 },
    { ...reminder, afterSeconds: 1.5 }, { ...reminder, afterSeconds: "1" }, { ...reminder, message: "  " },
    { ...reminder, message: "🐈".repeat(257) }]) {
    await expect(client.createReminder(invalid as AgentReminderInput)).rejects.toThrow(/^无效的提醒参数$/);
  }
  for (const character of ["\u0000", "\b", "\v", "\f", "\u000E", "\u001F", "\uD800", "\uDFFF", "\uFFFE", "\uFFFF"]) {
    await expect(client.createReminder({ ...reminder, message: "A" + character + "B" })).rejects.toThrow(/^无效的提醒参数$/);
  }
  expect(calls).toBe(0);
});

it.each(["错误能力的证明", "证明后断开"])("提醒%s时不发送凭证", async (reason) => {
  const requests: Array<[string | undefined, string | undefined]> = [];
  const baseUrl = await serve((req, res) => {
    requests.push([req.url, req.headers.authorization]);
    expect(req.headers["x-maneki-reminder-client"]).toBe(credential.clientId);
    expect(req.headers["x-maneki-briefing-challenge"]).toBeUndefined();
    if (reason === "证明后断开") res.setHeader("connection", "close");
    res.end(JSON.stringify(healthProof(req, "reminder", reason === "证明后断开" ? "reminder" : "briefing")));
  });
  await expect(createReminderClient({ baseUrl, tokenFile }).createReminder(reminder)).rejects.toThrow("无法验证 Runtime 的提醒身份");
  expect(requests).toEqual([["/v1/health", undefined]]);
});

it("在已验证的同一连接提交规范化参数，仅接受 200 和对应请求的有效回执", async () => {
  let body = JSON.stringify(receipt);
  let status = 200;
  const baseUrl = await serveVerified(async (req, res) => {
    expect([req.method, req.url]).toEqual(["POST", "/v1/reminders"]);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({ ...reminder, message: reminderMessage });
    res.writeHead(status).end(body);
  }, "reminder");
  const client = createReminderClient({ baseUrl, tokenFile });
  expect(await client.createReminder(reminder)).toEqual(receipt);
  for (const invalid of [{ requestId: "other" }, { reminderId: "id" }, { remindAt: 0.1 }, { remindAt: -1 },
    { remindAt: null }, { remindAt: 8640000000000001 }, { unexpected: "private" }]) {
    body = JSON.stringify({ ...receipt, ...invalid });
    await expect(client.createReminder(reminder)).rejects.toThrow(/^Runtime 提醒回执格式无效$/);
  }
  body = " ".repeat(1025);
  await expect(client.createReminder(reminder)).rejects.toThrow(/^Runtime 响应过大$/);
  for (status of [202, 403, 409]) {
    body = "private response";
    await expect(client.createReminder(reminder)).rejects.toThrow(`Runtime 拒绝提醒请求 (HTTP ${status})`);
  }
});

const summary = { reminderId: receipt.reminderId, message: reminderMessage, remindAt: receipt.remindAt, version: 2 };
const cancellation = { requestId: "cancel-1", reminderId: summary.reminderId, version: summary.version };
const cancelled = { requestId: cancellation.requestId, reminderId: cancellation.reminderId, cancelled: true };
const reschedule = { ...cancellation, requestId: "reschedule-1", afterSeconds: 3600 };
const rescheduled = { requestId: reschedule.requestId, reminderId: reschedule.reminderId,
  remindAt: summary.remindAt + 3600000, version: reschedule.version + 1 };

it.each([
  ["reminder-read", (options: ReminderClientOptions) => createReminderReadClient(options).listReminders()],
  ["reminder-cancel", (options: ReminderClientOptions) => createReminderCancelClient(options).cancelReminder(cancellation)],
  ["reminder-reschedule", (options: ReminderClientOptions) => createReminderRescheduleClient(options).rescheduleReminder(reschedule)],
] as const)("%s 只在同一连接收到对应证明后发送凭证", async (purpose, invoke) => {
  const requests: Array<[string | undefined, string | undefined]> = [];
  let reason = "缺少证明";
  const baseUrl = await serve((req, res) => {
    requests.push([req.url, req.headers.authorization]);
    expect(req.headers[`x-maneki-${purpose}-client`]).toBe(credential.clientId);
    expect(req.headers[`x-maneki-${purpose}-challenge`]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(req.headers["x-maneki-reminder-challenge"]).toBeUndefined();
    const body = healthProof(req, purpose, reason === "错误 HMAC 域" ? "reminder" : purpose);
    if (reason === "证明后断开") res.setHeader("connection", "close");
    if (reason === "缺少证明") {
      // 头部与 HMAC 域使用连字符，响应字段使用 camelCase。
      body[`${purpose}Proof`] = body[proofFields[purpose]];
      delete body[proofFields[purpose]];
    }
    res.end(JSON.stringify(body));
  });
  for (reason of ["缺少证明", "错误 HMAC 域", "证明后断开"]) {
    await expect(invoke({ baseUrl, tokenFile })).rejects.toThrow("无法验证 Runtime");
  }
  expect(requests).toEqual(Array(3).fill(["/v1/health", undefined]));
});

it("提醒改期只发送明确的目标、原版本和有效延时，只接受匹配的新版本回执", async () => {
  const requests: unknown[] = [];
  let body = JSON.stringify(rescheduled);
  let status = 200;
  const baseUrl = await serveVerified(async (req, res) => {
    expect([req.method, req.url]).toEqual(["POST", "/v1/reminders/reschedule"]);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(status).end(body);
  }, "reminder-reschedule");
  const client = createReminderRescheduleClient({ baseUrl, tokenFile });
  expect(Object.keys(client)).toEqual(["rescheduleReminder"]);
  for (const invalid of [
    cancellation, { ...reschedule, message: summary.message }, { ...reschedule, reminderId: "ab000000" },
    { ...reschedule, version: 0 }, { ...reschedule, afterSeconds: "3600" },
    ...[0, 1.5, 31622401].map((afterSeconds) => ({ ...reschedule, afterSeconds })),
  ]) {
    await expect(client.rescheduleReminder(invalid as AgentReminderRescheduleInput)).rejects.toThrow(/^无效的提醒改期参数$/);
  }
  expect(requests).toEqual([]);
  expect(await client.rescheduleReminder(reschedule)).toEqual(rescheduled);
  expect(await client.rescheduleReminder(reschedule)).toEqual(rescheduled);
  expect(requests).toEqual([reschedule, reschedule]);
  for (const fields of [{ requestId: "other" }, { reminderId: summary.reminderId.toUpperCase() },
    { remindAt: -1 }, { version: reschedule.version }, { version: reschedule.version + 2 }, { unexpected: "private" }]) {
    body = JSON.stringify({ ...rescheduled, ...fields });
    await expect(client.rescheduleReminder(reschedule)).rejects.toThrow(/^Runtime 提醒改期回执格式无效$/);
  }
  for (status of [202, 403, 404, 409, 429]) {
    body = "private response";
    await expect(client.rescheduleReminder(reschedule)).rejects.toThrow(`Runtime 拒绝改期提醒请求 (HTTP ${status})`);
  }
});

it("提醒查询接受整批上限和桌面编辑的正文，拒绝无效投影和超限响应", async () => {
  const summaries = {
    reminders: Array.from({ length: 200 }, (_, i) => ({
      ...summary, reminderId: `ab000000-0000-4000-a000-${i.toString(16).padStart(12, "0")}`, message: "\u0001".repeat(512),
    })),
  };
  let body = JSON.stringify(summaries);
  const baseUrl = await serveVerified((req, res) => {
    expect([req.method, req.url]).toEqual(["GET", "/v1/reminders/pending"]);
    res.end(body);
  }, "reminder-read");
  const client = createReminderReadClient({ baseUrl, tokenFile });
  expect(Object.keys(client)).toEqual(["listReminders"]);
  expect(await client.listReminders()).toEqual(summaries);
  for (const invalid of [
    { reminders: [], extra: "private" }, { reminders: null }, { reminders: Array(201).fill(summary) },
    ...[
      { reminderId: summary.reminderId.toUpperCase() }, { message: " " }, { message: "x".repeat(513) },
      { version: 0 }, { version: 1.5 }, { remindAt: -1 }, { internal: "private" },
    ].map((fields) => ({ reminders: [{ ...summary, ...fields }] })),
    { reminders: [summary, { ...summary, remindAt: summary.remindAt + 1 }] },
    { reminders: [summary, { ...summary, reminderId: summaries.reminders[0]!.reminderId }] },
  ]) {
    body = JSON.stringify(invalid);
    await expect(client.listReminders()).rejects.toThrow(/^Runtime 待投递提醒列表格式无效$/);
  }
  body = " ".repeat(640 * 1024 + 1);
  await expect(client.listReminders()).rejects.toThrow(/^Runtime 响应过大$/);
});

it("提醒取消在发送前拒绝模糊或无效目标，只接受匹配的回执并保留请求参数", async () => {
  const requests: unknown[] = [];
  let body = JSON.stringify(cancelled);
  let status = 200;
  const baseUrl = await serveVerified(async (req, res) => {
    expect([req.method, req.url]).toEqual(["POST", "/v1/reminders/cancel"]);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(status).end(body);
  }, "reminder-cancel");
  const client = createReminderCancelClient({ baseUrl, tokenFile });
  expect(Object.keys(client)).toEqual(["cancelReminder"]);
  for (const invalid of [
    { message: summary.message }, { requestId: cancellation.requestId, reminderId: cancellation.reminderId },
    { ...cancellation, reminderId: "ab000000" }, { ...cancellation, reminderId: cancellation.reminderId.toUpperCase() },
    { ...cancellation, version: 0 }, { ...cancellation, version: Number.MAX_SAFE_INTEGER + 1 },
    { ...cancellation, version: "2" }, { ...cancellation, requestId: "private/arg" }, { ...cancellation, message: summary.message },
  ]) {
    await expect(client.cancelReminder(invalid as AgentReminderCancelInput)).rejects.toThrow(/^无效的取消提醒参数$/);
  }
  expect(requests).toEqual([]);
  expect(await client.cancelReminder(cancellation)).toEqual(cancelled);
  expect(await client.cancelReminder(cancellation)).toEqual(cancelled);
  expect(requests).toEqual([cancellation, cancellation]);
  for (const fields of [{ requestId: "other" }, { reminderId: "other" }, { cancelled: false }, { private: "private" }]) {
    body = JSON.stringify({ ...cancelled, ...fields });
    await expect(client.cancelReminder(cancellation)).rejects.toThrow(/^Runtime 取消提醒回执格式无效$/);
  }
  for (status of [403, 404, 409]) {
    body = "private response";
    await expect(client.cancelReminder(cancellation)).rejects.toThrow(`Runtime 拒绝取消提醒请求 (HTTP ${status})`);
  }
});

const dailyCreate = { requestId: "daily-1", localTime: "08:00", message: reminder.message };
const dailySummary = { seriesId: receipt.reminderId, localTime: dailyCreate.localTime, message: reminderMessage,
  timeZone: "Asia/Shanghai", nextAt: Date.UTC(2026, 10, 22) };
const { message: _dailyMessage, ...dailyFields } = dailySummary;
const dailyReceipt = { requestId: dailyCreate.requestId, ...dailyFields };
const dailyCancel = { requestId: "cancel-1", seriesId: dailySummary.seriesId };
const dailyCancelled = { ...dailyCancel, cancelled: true };

it.each(["错误证明字段", "错误证明域", "证明后断开"])("周期提醒操作遇到%s时都不发送凭证", async (reason) => {
  const requests: Array<[string | undefined, string | undefined]> = [];
  const baseUrl = await serve((req, res) => {
    requests.push([req.url, req.headers.authorization]);
    expect(req.headers["x-maneki-reminder-recurring-client"]).toBe(credential.clientId);
    expect(req.headers["x-maneki-reminder-recurring-challenge"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(req.headers["x-maneki-reminder-challenge"]).toBeUndefined();
    const body = healthProof(req, "reminder-recurring", reason === "错误证明域" ? "reminder" : "reminder-recurring");
    if (reason === "错误证明字段") {
      body.reminderProof = body.recurringReminderProof;
      delete body.recurringReminderProof;
    }
    if (reason === "证明后断开") res.setHeader("connection", "close");
    res.end(JSON.stringify(body));
  });
  const client = createRecurringReminderClient({ baseUrl, tokenFile });
  await expect(client.createDailyReminder(dailyCreate)).rejects.toThrow("无法验证 Runtime 的每日提醒身份");
  await expect(client.listDailyReminders()).rejects.toThrow("无法验证 Runtime 的每日提醒身份");
  await expect(client.cancelDailyReminder(dailyCancel)).rejects.toThrow("无法验证 Runtime 的每日提醒身份");
  await expect(client.createWeekdayReminder(dailyCreate)).rejects.toThrow("无法验证 Runtime 的工作日提醒身份");
  await expect(client.listWeekdayReminders()).rejects.toThrow("无法验证 Runtime 的工作日提醒身份");
  await expect(client.cancelWeekdayReminder(dailyCancel)).rejects.toThrow("无法验证 Runtime 的工作日提醒身份");
  expect(requests).toEqual(Array(6).fill(["/v1/health", undefined]));
});

it("工作日规则复用同一凭证，严格校验输入、回执和列表，并只调用独立路由", async () => {
  let body: unknown = dailyReceipt;
  const requests: Array<[string | undefined, string | undefined, unknown]> = [];
  const baseUrl = await serveVerified(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push([req.method, req.url, chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined]);
    res.end(JSON.stringify(body));
  }, "reminder-recurring");
  const client = createRecurringReminderClient({ baseUrl, tokenFile });
  await expect(client.createWeekdayReminder({ ...dailyCreate, localTime: "8:00" })).rejects.toThrow(/^无效的工作日提醒参数$/);
  await expect(client.cancelWeekdayReminder({ ...dailyCancel, seriesId: dailyCancel.seriesId.toUpperCase() }))
    .rejects.toThrow(/^无效的取消工作日提醒参数$/);
  expect(requests).toEqual([]);

  expect(await client.createWeekdayReminder(dailyCreate)).toEqual(dailyReceipt);
  body = { reminders: [dailySummary] };
  expect(await client.listWeekdayReminders()).toEqual(body);
  body = dailyCancelled;
  expect(await client.cancelWeekdayReminder(dailyCancel)).toEqual(dailyCancelled);
  expect(requests).toEqual([
    ["POST", "/v1/recurring-reminders/weekdays", { ...dailyCreate, message: reminderMessage }],
    ["GET", "/v1/recurring-reminders/weekdays", undefined],
    ["POST", "/v1/recurring-reminders/weekdays/cancel", dailyCancel],
  ]);

  body = { ...dailyReceipt, localTime: "09:00" };
  await expect(client.createWeekdayReminder(dailyCreate)).rejects.toThrow(/^Runtime 工作日提醒回执格式无效$/);
  body = { reminders: [dailySummary, dailySummary] };
  await expect(client.listWeekdayReminders()).rejects.toThrow(/^Runtime 工作日提醒列表格式无效$/);
  body = { ...dailyCancelled, seriesId: "another" };
  await expect(client.cancelWeekdayReminder(dailyCancel)).rejects.toThrow(/^Runtime 取消工作日提醒回执格式无效$/);
});

it("每日规则只调用固定路由，拒绝额外字段、非规范时间与模糊目标，并严格校验回执", async () => {
  let body: unknown = dailyReceipt;
  let status = 200;
  const requests: Array<[string | undefined, string | undefined, unknown]> = [];
  const baseUrl = await serveVerified(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push([req.method, req.url, chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined]);
    res.writeHead(status).end(JSON.stringify(body));
  }, "reminder-recurring");
  const client = createRecurringReminderClient({ baseUrl, tokenFile });
  for (const invalid of [
    ...["8:00", "24:00", "08:60", "08:00\n", " 08:00", "08:00:00"].map((localTime) => ({ ...dailyCreate, localTime })),
    { ...dailyCreate, timeZone: "UTC" }, { ...dailyCreate, requestId: "private/path" }, { ...dailyCreate, message: "A\u0000B" },
    { ...dailyCreate, message: "🐈".repeat(257) },
  ]) {
    await expect(client.createDailyReminder(invalid as DailyReminderInput)).rejects.toThrow(/^无效的每日提醒参数$/);
  }
  for (const invalid of [
    { ...dailyCancel, seriesId: "ab000000" }, { ...dailyCancel, seriesId: dailyCancel.seriesId.toUpperCase() },
    { ...dailyCancel, requestId: "private/path" }, { ...dailyCancel, message: dailySummary.message },
  ]) {
    await expect(client.cancelDailyReminder(invalid as DailyReminderCancelInput)).rejects.toThrow(/^无效的取消每日提醒参数$/);
  }
  expect(requests).toEqual([]);
  expect(await client.createDailyReminder(dailyCreate)).toEqual(dailyReceipt);
  body = { reminders: [dailySummary] };
  expect(await client.listDailyReminders()).toEqual(body);
  body = dailyCancelled;
  expect(await client.cancelDailyReminder(dailyCancel)).toEqual(dailyCancelled);
  expect(requests).toEqual([
    ["POST", "/v1/recurring-reminders", { ...dailyCreate, message: reminderMessage }],
    ["GET", "/v1/recurring-reminders", undefined],
    ["POST", "/v1/recurring-reminders/cancel", dailyCancel],
  ]);
  for (const fields of [
    { requestId: "other" }, { seriesId: dailySummary.seriesId.toUpperCase() }, { localTime: "09:00" },
    { timeZone: "invalid zone" }, { nextAt: 0.1 }, { nextAt: 8640000000000001 }, { private: "private" },
  ]) {
    body = { ...dailyReceipt, ...fields };
    await expect(client.createDailyReminder(dailyCreate)).rejects.toThrow(/^Runtime 每日提醒回执格式无效$/);
  }
  for (const fields of [{ requestId: "other" }, { seriesId: "other" }, { cancelled: false }, { private: "private" }]) {
    body = { ...dailyCancelled, ...fields };
    await expect(client.cancelDailyReminder(dailyCancel)).rejects.toThrow(/^Runtime 取消每日提醒回执格式无效$/);
  }
  status = 202;
  body = "private response";
  await expect(client.createDailyReminder(dailyCreate)).rejects.toThrow(/^Runtime 拒绝创建每日提醒请求 \(HTTP 202\)$/);
});

it("每日规则列表接受单身份上限，拒绝非规范正文、重复或乱序规则和超限响应", async () => {
  const reminders = Array.from({ length: 8 }, (_, i) => ({
    ...dailySummary, seriesId: `ab000000-0000-4000-a000-${i.toString(16).padStart(12, "0")}`, message: "🐈".repeat(256),
  }));
  let body = JSON.stringify({ reminders });
  const baseUrl = await serveVerified((_req, res) => res.end(body), "reminder-recurring");
  const client = createRecurringReminderClient({ baseUrl, tokenFile });
  expect(await client.listDailyReminders()).toEqual({ reminders });
  for (const invalid of [
    { reminders: [], extra: true }, { reminders: null }, { reminders: [...reminders, dailySummary] },
    { reminders: [dailySummary, { ...dailySummary, nextAt: dailySummary.nextAt + 1 }] },
    { reminders: [reminders[1], reminders[0]] },
    { reminders: [{ ...reminders[0], nextAt: dailySummary.nextAt + 1 }, reminders[1]] },
    ...[{ localTime: "24:00" }, { timeZone: "invalid zone" }, { nextAt: 0.1 }, { message: " A " },
      { message: null }, { message: "A\u0000B" }, { message: "🐈".repeat(257) }, { notes: "private" },
    ].map((fields) => ({ reminders: [{ ...dailySummary, ...fields }] })),
  ]) {
    body = JSON.stringify(invalid);
    await expect(client.listDailyReminders()).rejects.toThrow(/^Runtime 每日提醒列表格式无效$/);
  }
  body = " ".repeat(32 * 1024 + 1);
  await expect(client.listDailyReminders()).rejects.toThrow(/^Runtime 响应过大$/);
});

const dailyReschedule = { requestId: "daily-move", seriesId: dailySummary.seriesId, localTime: "09:00", version: 1 };
const dailyRescheduled = { ...dailyFields, ...dailyReschedule, version: 2 };
const recurringRescheduleCases = [
  { label: "每日提醒", basePath: "/v1/recurring-reminders/reschedule", list: "listTargets", move: "rescheduleDailyReminder" },
  { label: "工作日提醒", basePath: "/v1/recurring-reminders/weekdays/reschedule", list: "listWeekdayTargets", move: "rescheduleWeekdayReminder" },
] as const;

it.each(["旧每日提醒证明字段", "旧每日提醒证明域", "证明后断开"])("周期提醒改期遇到%s时不会发送凭证", async (reason) => {
  const requests: Array<[string | undefined, string | undefined]> = [];
  const capability = "reminder-recurring-reschedule";
  const baseUrl = await serve((req, res) => {
    requests.push([req.url, req.headers.authorization]);
    expect(req.headers[`x-maneki-${capability}-client`]).toBe(credential.clientId);
    expect(req.headers[`x-maneki-${capability}-challenge`]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(req.headers["x-maneki-reminder-recurring-challenge"]).toBeUndefined();
    const proof = healthProof(req, capability, reason === "旧每日提醒证明域" ? "reminder-recurring" : capability);
    if (reason === "旧每日提醒证明字段") {
      proof.recurringReminderProof = proof.recurringReminderRescheduleProof;
      delete proof.recurringReminderRescheduleProof;
    }
    if (reason === "证明后断开") res.setHeader("connection", "close");
    res.end(JSON.stringify(proof));
  });
  const client = createRecurringReminderRescheduleClient({ baseUrl, tokenFile });
  for (const { label, list, move } of recurringRescheduleCases) {
    await expect(client[list]()).rejects.toThrow(`无法验证 Runtime 的${label}改期身份`);
    await expect(client[move](dailyReschedule)).rejects.toThrow(`无法验证 Runtime 的${label}改期身份`);
  }
  expect(requests).toEqual(Array.from({ length: 4 }, () => ["/v1/health", undefined]));
});

it.each(recurringRescheduleCases)("$label改期只调用专用路由，拒绝模糊或额外参数并校验对应回执", async ({ label, basePath, list, move }) => {
  let body: unknown = dailyRescheduled;
  const requests: Array<[string | undefined, string | undefined, unknown]> = [];
  const baseUrl = await serveVerified(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push([req.method, req.url, chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined]);
    res.end(JSON.stringify(body));
  }, "reminder-recurring-reschedule");
  const client = createRecurringReminderRescheduleClient({ baseUrl, tokenFile });
  expect(Object.keys(client)).toEqual(["listTargets", "rescheduleDailyReminder", "listWeekdayTargets", "rescheduleWeekdayReminder"]);
  for (const invalid of [
    { ...dailyCancel, localTime: "09:00" }, { ...dailyReschedule, seriesId: "ab000000" },
    { ...dailyReschedule, seriesId: dailyReschedule.seriesId.toUpperCase() }, { ...dailyReschedule, requestId: "private/path" },
    { ...dailyReschedule, message: dailySummary.message }, { ...dailyReschedule, timeZone: "UTC" },
    ...[0, 1.5, "1", Number.MAX_SAFE_INTEGER + 1].map((version) => ({ ...dailyReschedule, version })),
    ...["9:00", "24:00", "09:00\n", "09:00:00"].map((localTime) => ({ ...dailyReschedule, localTime })),
  ]) {
    await expect(client[move](invalid as DailyReminderRescheduleInput)).rejects.toThrow(new RegExp(`^无效的${label}改期参数$`));
  }
  expect(requests).toEqual([]);
  expect(await client[move](dailyReschedule)).toEqual(dailyRescheduled);
  expect(await client[move](dailyReschedule)).toEqual(dailyRescheduled);
  body = { reminders: [{ ...dailySummary, version: 1 }] };
  expect(await client[list]()).toEqual(body);
  expect(requests).toEqual([
    ["POST", basePath, dailyReschedule],
    ["POST", basePath, dailyReschedule],
    ["GET", `${basePath}/targets`, undefined],
  ]);
  for (const fields of [
    { requestId: "other" }, { seriesId: "ab000000-0000-4000-a000-000000000002" }, { localTime: "08:00" },
    { timeZone: "invalid zone" }, { nextAt: 0.1 }, { version: 1 }, { version: 3 }, { version: "2" }, { private: "private" },
  ]) {
    body = { ...dailyRescheduled, ...fields };
    await expect(client[move](dailyReschedule)).rejects.toThrow(new RegExp(`^Runtime ${label}改期回执格式无效$`));
  }
});

it.each(recurringRescheduleCases)("$label改期目标须带正安全版本，列表有序且受单身份条数与字节上限约束", async ({ label, list }) => {
  const reminders = Array.from({ length: 8 }, (_, i) => ({
    ...dailySummary, seriesId: `ab000000-0000-4000-a000-${i.toString(16).padStart(12, "0")}`, version: i + 1,
  }));
  let body = JSON.stringify({ reminders });
  const baseUrl = await serveVerified((_req, res) => res.end(body), "reminder-recurring-reschedule");
  const client = createRecurringReminderRescheduleClient({ baseUrl, tokenFile });
  expect(await client[list]()).toEqual({ reminders });
  for (const invalid of [
    { reminders: [], extra: true }, { reminders: [dailySummary] }, { reminders: [...reminders, { ...dailySummary, version: 1 }] },
    { reminders: [reminders[0], reminders[0]] }, { reminders: [reminders[1], reminders[0]] },
    ...[0, "1", 1.5, Number.MAX_SAFE_INTEGER + 1].map((version) => ({ reminders: [{ ...dailySummary, version }] })),
  ]) {
    body = JSON.stringify(invalid);
    await expect(client[list]()).rejects.toThrow(new RegExp(`^Runtime ${label}改期目标列表格式无效$`));
  }
  body = " ".repeat(32 * 1024 + 1);
  await expect(client[list]()).rejects.toThrow(/^Runtime 响应过大$/);
});
