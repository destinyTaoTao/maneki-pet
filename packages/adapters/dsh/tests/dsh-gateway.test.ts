import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { DshAdapter, DshGatewayClient } from "../src/index.js";

const TOKEN = "test-gate-token";

interface StubSession {
  sessionId: string;
  cwd?: string | undefined;
  prompts: Array<{ requestId: string; mode: string; text: string }>;
  cancelled: boolean;
  seq: number;
}

const sessions = new Map<string, StubSession>();
let createCount = 0;
let requestCount = 0;

function stubJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    req.on("end", () => resolve(JSON.parse(raw)));
  });
}

async function startStub(): Promise<{ server: Server; port: number }> {
  const server = createServer(async (req, res) => {
    requestCount += 1;
    const url = (req.url ?? "").split("?")[0] ?? "";
    if (url === "/" && req.headers.cookie === undefined) {
      const tokenUrl = new URL(req.url ?? "/", `http://127.0.0.1`);
      if (tokenUrl.searchParams.get("token") === TOKEN) {
        res.writeHead(303, { "set-cookie": "dsh-auth-test=v1.stubsignature; Path=/; HttpOnly" });
        res.end();
        return;
      }
      stubJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (!url.startsWith("/api/")) {
      stubJson(res, 404, { error: "not found" });
      return;
    }
    if (req.headers.cookie !== "dsh-auth-test=v1.stubsignature") {
      stubJson(res, 401, { error: "unauthorized" });
      return;
    }
    const body = (await readBody(req)) as { rpcId?: string; payload?: { args?: Record<string, unknown> } };
    const endpoint = url.slice("/api/".length);
    const request = (body.payload?.args?.request ?? body.payload?.args?._request ?? {}) as Record<string, unknown>;

    if (endpoint === "session/create") {
      createCount += 1;
      const sessionId = `session-stub-${createCount}`;
      sessions.set(sessionId, { sessionId, cwd: request.cwd as string | undefined, prompts: [], cancelled: false, seq: 0 });
      stubJson(res, 200, {
        type: "server-response",
        rpcId: body.rpcId,
        result: { ok: true, value: { sessionId } },
      });
      return;
    }
    if (endpoint === "session/prompt") {
      const sessionId = request.sessionId as string;
      const session = sessions.get(sessionId);
      if (!session) {
        stubJson(res, 200, { type: "server-response", rpcId: body.rpcId, result: { ok: false, error: { code: "gateway/arguments-invalid", message: "unknown session", details: {} } } });
        return;
      }
      const text = (request.content as Array<{ text: string }>)[0]?.text ?? "";
      session.prompts.push({ requestId: request.requestId as string, mode: request.mode as string, text });
      session.seq += 1;
      stubJson(res, 200, { type: "server-response", rpcId: body.rpcId, result: { ok: true, value: { accepted: true } } });
      return;
    }
    if (endpoint === "session/projections") {
      const sessionId = request.sessionId as string;
      const session = sessions.get(sessionId);
      if (!session) {
        stubJson(res, 200, { type: "server-response", rpcId: body.rpcId, result: { ok: false, error: { code: "gateway/arguments-invalid", message: "unknown session", details: {} } } });
        return;
      }
      session.seq += 1;
      const outline = session.prompts.map((prompt, index) => ({
        turn: index + 1,
        seq: session.seq,
        prompt: prompt.text,
        response: `RESP:${prompt.text}`,
      }));
      stubJson(res, 200, {
        type: "server-response",
        rpcId: body.rpcId,
        result: {
          ok: true,
          value: {
            asOfSeq: session.seq,
            values: {
              turnOutline: outline,
              tokenUsage: { uncachedInputTokens: 100, outputTokens: 10 },
              permissions: { currentValue: "workspace-write" },
            },
          },
        },
      });
      return;
    }
    if (endpoint === "session/cancel") {
      const session = sessions.get(request.sessionId as string);
      if (session) session.cancelled = true;
      stubJson(res, 200, { type: "server-response", rpcId: body.rpcId, result: { ok: true, value: { accepted: true } } });
      return;
    }
    stubJson(res, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

const servers: Array<{ server: Server }> = [];

afterEach(() => {
  for (const entry of servers.splice(0)) {
    entry.server.close();
  }
  sessions.clear();
  createCount = 0;
  requestCount = 0;
});

async function makeAdapter(): Promise<{ adapter: DshAdapter; port: number }> {
  const { server, port } = await startStub();
  servers.push({ server });
  const adapter = new DshAdapter({ gateway: { baseUrl: `http://127.0.0.1:${port}`, token: TOKEN } });
  return { adapter, port };
}

const ctx = { requestId: "req-1", signal: new AbortController().signal, deadlineAtMs: Number.MAX_SAFE_INTEGER };

describe("dsh 网关线协议", () => {
  it("通过受控替身交换凭证并发送会话请求", async () => {
    const { server, port } = await startStub();
    servers.push({ server });
    const client = new DshGatewayClient({ baseUrl: `http://127.0.0.1:${port}`, token: TOKEN });
    const created = await client.createSession({ cwd: "C:\\tmp" });
    const sessionId = created.sessionId!;
    await client.prompt({ sessionId, requestId: "r1", mode: "queue", content: [{ type: "text", text: "hello" }] });
    expect((await client.projections(sessionId)).values?.turnOutline?.[0]?.response).toBe("RESP:hello");
    expect(await client.cancelSession(sessionId)).toEqual({ accepted: true });
  });

  it("错误令牌不能建立会话", async () => {
    const { server, port } = await startStub();
    servers.push({ server });
    const client = new DshGatewayClient({ baseUrl: `http://127.0.0.1:${port}`, token: "wrong" });
    await expect(client.createSession({})).rejects.toThrow(/login failed/);
    expect(sessions.size).toBe(0);
  });
});

describe("DshAdapter 未验证的网关", () => {
  it("配置网关不授予事件、执行或审批能力", async () => {
    const { adapter } = await makeAdapter();
    expect(adapter.capabilities).toEqual({
      events: false,
      newTask: false,
      continueSession: false,
      reply: false,
      query: "none",
      cancel: false,
      deduplicateSubmit: false,
      approval: "none",
      sessionOverview: false,
    });
  });

  it("直接调用未验证操作均拒绝，网关不会收到请求", async () => {
    const { adapter } = await makeAdapter();
    const ref = { brokerRequestId: "br-1", taskId: "t", sessionId: "s" };
    await expect(adapter.submit({ brokerRequestId: "br-1", prompt: "x", target: { kind: "new", workdir: "C:\\tmp" } }, ctx)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(adapter.subscribe(() => undefined, ctx)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(adapter.query({ brokerRequestId: "br-1" }, ctx)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(adapter.reply(ref, { inputId: "i", text: "x" }, ctx)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(adapter.cancel(ref, ctx)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(sessions.size).toBe(0);
    expect(requestCount).toBe(0);
  });

});

describe("DshAdapter 观察模式（无 gateway 配置）", () => {
  it("保持观察能力；派发方法显式拒绝", async () => {
    const adapter = new DshAdapter();
    expect(adapter.capabilities.newTask).toBe(false);
    expect(adapter.capabilities.approval).toBe("none");
    await expect(
      adapter.submit({ brokerRequestId: "b", prompt: "x", target: { kind: "new", workdir: "C:\\tmp" } }, ctx),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});
