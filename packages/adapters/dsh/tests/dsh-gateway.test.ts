import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { DshAdapter } from "../src/index.js";

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
});

async function makeAdapter(): Promise<{ adapter: DshAdapter; port: number }> {
  const { server, port } = await startStub();
  servers.push({ server });
  const adapter = new DshAdapter({ gateway: { baseUrl: `http://127.0.0.1:${port}`, token: TOKEN } });
  return { adapter, port };
}

const ctx = { requestId: "req-1", signal: new AbortController().signal, deadlineAtMs: Number.MAX_SAFE_INTEGER };

describe("DshAdapter 网关派发模式", () => {
  it("配置 gateway 后能力升级为派发（native 审批 + status_only 查询）", async () => {
    const { adapter } = await makeAdapter();
    expect(adapter.capabilities).toEqual({
      events: true,
      newTask: true,
      continueSession: true,
      reply: true,
      query: "status_only",
      cancel: true,
      deduplicateSubmit: false,
      approval: "native",
      sessionOverview: false,
    });
  });

  it("submit：受控新会话 + prompt 原生幂等键 = brokerRequestId", async () => {
    const { adapter } = await makeAdapter();
    const ref = await adapter.submit(
      { brokerRequestId: "br-1", prompt: "翻译 README", target: { kind: "new", workdir: "C:\\tmp\\proj" } },
      ctx,
    );
    expect(ref.brokerRequestId).toBe("br-1");
    expect(ref.sessionId).toMatch(/^session-stub-/);
    expect(ref.taskId).toBe(ref.sessionId);
  });

  it("query：完成后返回 status_only 快照与结果摘要", async () => {
    const { adapter } = await makeAdapter();
    await adapter.submit(
      { brokerRequestId: "br-2", prompt: "修复构建", target: { kind: "new", workdir: "C:\\tmp\\proj" } },
      ctx,
    );
    const result = await adapter.query({ brokerRequestId: "br-2" }, ctx);
    expect(result.outcome).toBe("found");
    if (result.outcome === "found") {
      expect(result.snapshot.status).toBe("completed");
      expect(result.snapshot.completeness).toBe("status_only");
      expect(result.snapshot.result?.summary).toBe("RESP:修复构建");
      expect(result.snapshot.sourcePosition?.streamId).toMatch(/^dsh-gateway-/);
    }
  });

  it("query 未知 brokerRequestId → not_found", async () => {
    const { adapter } = await makeAdapter();
    expect(await adapter.query({ brokerRequestId: "nope" }, ctx)).toEqual({ outcome: "not_found" });
  });

  it("reply：steer 模式补充输入（requestId = inputId），原任务结果不变", async () => {
    const { adapter } = await makeAdapter();
    const ref = await adapter.submit(
      { brokerRequestId: "br-3", prompt: "开始任务", target: { kind: "new", workdir: "C:\\tmp\\proj" } },
      ctx,
    );
    await adapter.reply(ref, { inputId: "in-9", text: "补充：使用 TypeScript" }, ctx);
    const recorded = sessions.get(ref.sessionId)?.prompts ?? [];
    expect(recorded).toHaveLength(2);
    expect(recorded[1]).toEqual({ requestId: "in-9", mode: "steer", text: "补充：使用 TypeScript" });
    const result = await adapter.query({ brokerRequestId: "br-3" }, ctx);
    if (result.outcome === "found") {
      expect(result.snapshot.result?.summary).toBe("RESP:开始任务");
    }
  });

  it("cancel：dsh 接受取消后状态标记为 cancelled", async () => {
    const { adapter } = await makeAdapter();
    const ref = await adapter.submit(
      { brokerRequestId: "br-4", prompt: "长任务", target: { kind: "new", workdir: "C:\\tmp\\proj" } },
      ctx,
    );
    await adapter.cancel(ref, ctx);
    const result = await adapter.query({ brokerRequestId: "br-4" }, ctx);
    if (result.outcome === "found") {
      expect(result.snapshot.status).toBe("cancelled");
    }
  });

  it("错误令牌：submit 在登录阶段失败", async () => {
    const { server, port } = await startStub();
    servers.push({ server });
    const adapter = new DshAdapter({ gateway: { baseUrl: `http://127.0.0.1:${port}`, token: "wrong-token" } });
    await expect(
      adapter.submit({ brokerRequestId: "br-x", prompt: "x", target: { kind: "new", workdir: "C:\\tmp" } }, ctx),
    ).rejects.toThrow(/login failed/);
  });
});

describe("DshAdapter 观察模式（无 gateway 配置）", () => {
  it("保持观察能力；派发方法显式拒绝", async () => {
    const adapter = new DshAdapter();
    expect(adapter.capabilities.newTask).toBe(false);
    expect(adapter.capabilities.approval).toBe("none");
    await expect(
      adapter.submit({ brokerRequestId: "b", prompt: "x", target: { kind: "new", workdir: "C:\\tmp" } }, ctx),
    ).rejects.toThrow(/gateway configuration/);
  });
});
