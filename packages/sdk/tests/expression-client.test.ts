import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type RequestListener } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createBriefingClient, createExpressionClient, createReminderClient, type AgentReminderInput } from "../src/index.js";

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

type Capability = "expression" | "briefing" | "reminder";

function healthProof(req: IncomingMessage, capability: Capability = "expression", domain = capability) {
  const key = createHash("sha256").update(credential.token).digest();
  const proof = createHmac("sha256", key).update(JSON.stringify([
    `maneki-${domain}-proof-v1`, req.headers[`x-maneki-${capability}-client`],
    req.headers[`x-maneki-${capability}-challenge`], credential.instanceId, req.socket.localPort,
  ])).digest("hex");
  return { protocolVersion: 1, instanceId: credential.instanceId, [`${capability}Proof`]: proof };
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
