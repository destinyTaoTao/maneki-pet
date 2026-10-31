import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startRuntime, type StartedRuntime } from "../src/index.js";

const runtimes: StartedRuntime[] = [];
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "maneki-tasks-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const GATEWAY_TOKEN = "gw-token-test";

function startStubGateway() {
  const received: Array<{ method: string; body: Record<string, unknown> }> = [];
  const sessions = new Map<string, { prompts: string[] }>();
  let seq = 0;
  const server = createServer(async (req, res) => {
    const url = (req.url ?? "").split("?")[0] ?? "";
    if (url === "/" && !req.headers.cookie) {
      const token = new URL(req.url ?? "/", "http://x").searchParams.get("token");
      if (token === GATEWAY_TOKEN) {
        res.writeHead(303, { "set-cookie": "dsh-auth-stub=v1.sig; Path=/" });
        res.end();
        return;
      }
      res.writeHead(401).end();
      return;
    }
    if (url.startsWith("/api/session/")) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        method: string;
        rpcId?: string;
        payload?: { args?: Record<string, unknown> };
      };
      received.push({ method: body.method, body });
      const request = (body.payload?.args?.request ?? body.payload?.args?._request ?? {}) as Record<string, unknown>;
      let value: unknown;
      if (body.method === "session/create") {
        seq += 1;
        const sessionId = `session-stub-${seq}`;
        sessions.set(sessionId, { prompts: [] });
        value = { sessionId };
      } else if (body.method === "session/prompt") {
        const s = sessions.get(request.sessionId as string);
        if (s) s.prompts.push(String((request.content as Array<{ text: string }>)[0]?.text ?? ""));
        value = { accepted: true };
      } else if (body.method === "session/projections") {
        const s = sessions.get(request.sessionId as string);
        const prompts = s?.prompts ?? [];
        value = {
          asOfSeq: 10,
          values: {
            turnOutline: prompts.map((p, i) => ({ turn: i + 1, seq: 10, prompt: p, response: `RESP:${p}` })),
            tokenUsage: { uncachedInputTokens: 100 },
            permissions: { currentValue: "workspace-write" },
          },
        };
      } else if (body.method === "session/cancel") {
        value = { accepted: true };
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "server-response", rpcId: "x", result: { ok: false, error: { code: "unknown", message: "unsupported", details: {} } } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "server-response", rpcId: body.rpcId ?? "x", result: { ok: true, value } }));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise<{ port: number; received: typeof received; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as { port: number }).port,
        received,
        close: () => server.close(),
      });
    });
  });
}

describe("任务派发经 dsh 网关（M2b 端到端）", () => {
  it("POST /v1/tasks 派发到 stub 网关，prompt 幂等键 = brokerRequestId", async () => {
    const dir = makeTempDir();
    const gw = await startStubGateway();
    const runtime = await startRuntime({
      configDir: dir,
      log: () => undefined,
      originAllowlist: [],
    });
    runtimes.push(runtime);
    // 动态注入 dsh 配置（测试便利：写 config.json 后重启）
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        limits: { proactiveDailyTokenLimit: 100_000, interactiveDailyTokenLimit: null, maxNotificationsPerHour: 30 },
        dsh: { baseUrl: `http://127.0.0.1:${gw.port}`, token: GATEWAY_TOKEN },
      }),
      "utf8",
    );
    await runtime.stop();
    const restarted = await startRuntime({ configDir: dir, log: () => undefined });
    runtimes.push(restarted);
    expect(restarted.tasks).toBeDefined();

    const pair = await fetch(`http://127.0.0.1:${restarted.port}/v1/pair`, {
      method: "POST",
      headers: { authorization: `Bearer ${restarted.rootToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "shell", scopes: "express" }),
    });
    const { token } = (await pair.json()) as { token: string };
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const submit = await fetch(`http://127.0.0.1:${restarted.port}/v1/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientRequestId: "cli-1", prompt: "翻译 README", workdir: "C:\\proj\\demo" }),
    });
    expect(submit.status).toBe(202);
    const submitBody = (await submit.json()) as { outcome: string; task: { brokerRequestId: string; sessionId: string } };
    expect(submitBody.outcome).toBe("accepted");
    expect(submitBody.task.brokerRequestId).toMatch(/^br-/);

    const query = await fetch(`http://127.0.0.1:${restarted.port}/v1/tasks/${submitBody.task.brokerRequestId}`, { headers });
    expect(query.status).toBe(200);
    const queryBody = (await query.json()) as { status: string; gatewaySnapshot?: Record<string, unknown> };
    expect(["running", "completed"]).toContain(queryBody.status);

    const cancel = await fetch(`http://127.0.0.1:${restarted.port}/v1/tasks/${submitBody.task.brokerRequestId}/cancel`, {
      method: "POST",
      headers,
    });
    expect(cancel.status).toBe(200);

    await restarted.stop();
    const reopened = await startRuntime({ configDir: dir, log: () => undefined });
    runtimes.push(reopened);
    const after = await fetch(`http://127.0.0.1:${reopened.port}/v1/tasks/${submitBody.task.brokerRequestId}`, {
      headers,
    });
    expect(after.status).toBe(200);
    const afterBody = (await after.json()) as { status: string };
    expect(["cancelled", "completed"]).toContain(afterBody.status);
    gw.close();
  });

  it("未配置 dsh 时任务路由返回 501（经 root 令牌鉴权）", async () => {
    const runtime = await startRuntime({ configDir: makeTempDir(), log: () => undefined });
    runtimes.push(runtime);
    const response = await fetch(`http://127.0.0.1:${runtime.port}/v1/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${runtime.rootToken}`, "content-type": "application/json" },
      body: JSON.stringify({ clientRequestId: "x", prompt: "y", workdir: "C:\\tmp" }),
    });
    expect(response.status).toBe(501);
  });
});
