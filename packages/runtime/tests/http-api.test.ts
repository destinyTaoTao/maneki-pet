import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startRuntime, type StartedRuntime } from "../src/index.js";

const runtimes: StartedRuntime[] = [];
const tempDirs: string[] = [];

async function makeRuntime(originAllowlist: string[] = []): Promise<{ runtime: StartedRuntime; base: string }> {
  const dir = mkdtempSync(join(tmpdir(), "maneki-rt-http-"));
  tempDirs.push(dir);
  const runtime = await startRuntime({ configDir: dir, originAllowlist, log: () => undefined });
  runtimes.push(runtime);
  return { runtime, base: `http://127.0.0.1:${runtime.port}` };
}

async function jsonFetch(
  base: string,
  path: string,
  init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "content-type": "application/json", ...init.headers };
  if (init.token) {
    headers.authorization = `Bearer ${init.token}`;
  }
  const requestInit: RequestInit = {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  };
  const response = await fetch(`${base}${path}`, requestInit);
  return { status: response.status, body: (await response.json()) as any };
}

/** fetch 不能自定义 Host 头，Host/Origin 矩阵用原生 http 请求。 */
function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers, method: "GET" }, (res) => {
      let raw = "";
      res.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as any }));
    });
    req.on("error", reject);
    req.end();
  });
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("本地 HTTP API 鉴权矩阵", () => {
  it("健康检查不需要令牌，且不泄露令牌", async () => {
    const { runtime, base } = await makeRuntime();
    const { status, body } = await jsonFetch(base, "/v1/health");
    expect(status).toBe(200);
    expect(body.protocolVersion).toBe(1);
    expect(body.instanceId).toMatch(/^rt-/);
    expect(JSON.stringify(body)).not.toContain(runtime.rootToken);
  });

  it("缺令牌 401、错令牌 401、root 令牌打 express 接口 403", async () => {
    const { runtime, base } = await makeRuntime();
    expect((await jsonFetch(base, "/v1/limits")).status).toBe(401);
    expect((await jsonFetch(base, "/v1/limits", { token: "not-a-real-token" })).status).toBe(401);
    const admin = await jsonFetch(base, "/v1/limits", { token: runtime.rootToken });
    expect(admin.status).toBe(403);
    expect(admin.body.error).toContain("express");
  });

  it("Host 必须是绑定地址，浏览器 Origin 必须在白名单", async () => {
    const { runtime } = await makeRuntime();
    const badHost = await rawRequest(runtime.port, "/v1/health", { host: "evil.example:1" });
    expect(badHost.status).toBe(403);
    const badOrigin = await rawRequest(runtime.port, "/v1/health", {
      host: `127.0.0.1:${runtime.port}`,
      origin: "https://evil.example",
    });
    expect(badOrigin.status).toBe(403);
  });

  it("配对流程：root 签发 express 客户端，签发 admin 范围被拒绝", async () => {
    const { runtime, base } = await makeRuntime();
    const pair = await jsonFetch(base, "/v1/pair", { token: runtime.rootToken, body: { name: "shell", scopes: "express,notify" } });
    expect(pair.status).toBe(200);
    expect(pair.body.clientId).toMatch(/^client-/);

    const adminPair = await jsonFetch(base, "/v1/pair", { token: runtime.rootToken, body: { name: "bad", scopes: "admin" } });
    expect(adminPair.status).toBe(400);
    expect(adminPair.body.error).toContain("unknown scope");
  });

  it("撤销后的客户端令牌立即失效", async () => {
    const { runtime, base } = await makeRuntime();
    const pair = await jsonFetch(base, "/v1/pair", { token: runtime.rootToken, body: { name: "shell", scopes: "express" } });
    const { clientId, token } = pair.body as { clientId: string; token: string };
    expect((await jsonFetch(base, "/v1/limits", { token })).status).toBe(200);

    const revoke = await jsonFetch(base, `/v1/clients/${clientId}/revoke`, { token: runtime.rootToken, body: {} });
    expect(revoke.status).toBe(200);
    expect((await jsonFetch(base, "/v1/limits", { token })).status).toBe(401);
  });

  it("未知字段拒绝、越界数值拒绝", async () => {
    const { runtime, base } = await makeRuntime();
    const pair = await jsonFetch(base, "/v1/pair", { token: runtime.rootToken, body: { name: "shell", scopes: "express" } });
    const token = (pair.body as { token: string }).token;

    const unknownField = await jsonFetch(base, "/v1/usage/record", { token, body: { kind: "interactive", tokens: 1, extra: true } });
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.error).toContain('unknown field "extra"');

    const badValue = await jsonFetch(base, "/v1/usage/record", { token, body: { kind: "interactive", tokens: -5 } });
    expect(badValue.status).toBe(400);
    expect(badValue.body.error).toContain('"tokens"');
  });
});

describe("限额持久化与查询（#43 的 Runtime 层）", () => {
  it("用量记账后限额视图反映剩余额度", async () => {
    const { runtime, base } = await makeRuntime();
    const pair = await jsonFetch(base, "/v1/pair", { token: runtime.rootToken, body: { name: "shell", scopes: "express" } });
    const token = (pair.body as { token: string }).token;

    const before = await jsonFetch(base, "/v1/limits", { token });
    expect(before.body.proactive.limit).toBe(100_000);
    expect(before.body.proactive.used).toBe(0);
    expect(before.body.interactive).toBeNull();

    await jsonFetch(base, "/v1/usage/record", { token, body: { kind: "proactive", tokens: 4_000 } });
    const after = await jsonFetch(base, "/v1/limits", { token });
    expect(after.body.proactive.used).toBe(4_000);
    expect(after.body.proactive.remaining).toBe(96_000);
    expect(after.body.meteringHealthy).toBe(true);
  });

  it("交互总额开启后进入限额视图，且用量跨重启保留", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maneki-rt-quota-"));
    tempDirs.push(dir);
    const write = (await import("node:fs")).writeFileSync;
    write(
      join(dir, "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        limits: { proactiveDailyTokenLimit: 50_000, interactiveDailyTokenLimit: 10_000, maxNotificationsPerHour: 30 },
      }),
      "utf8",
    );
    const first = await startRuntime({ configDir: dir, log: () => undefined });
    runtimes.push(first);
    const pair = await jsonFetch(`http://127.0.0.1:${first.port}`, "/v1/pair", {
      token: first.rootToken,
      body: { name: "shell", scopes: "express" },
    });
    const token = (pair.body as { token: string }).token;
    await jsonFetch(`http://127.0.0.1:${first.port}`, "/v1/usage/record", { token, body: { kind: "interactive", tokens: 2_500 } });
    await first.stop();

    const second = await startRuntime({ configDir: dir, log: () => undefined });
    runtimes.push(second);
    const view = await jsonFetch(`http://127.0.0.1:${second.port}`, "/v1/limits", { token });
    expect(view.status).toBe(200);
    expect(view.body.interactive).toEqual({ limit: 10_000, used: 2_500, remaining: 7_500 });
    expect(view.body.proactive.used).toBe(2_500);
  });

  it("配置 Schema 版本不符时拒绝启动并保留原因", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maneki-rt-cfg-"));
    tempDirs.push(dir);
    const write = (await import("node:fs")).writeFileSync;
    write(join(dir, "config.json"), JSON.stringify({ schemaVersion: 2, limits: {} }), "utf8");
    await expect(startRuntime({ configDir: dir, log: () => undefined })).rejects.toThrow(/schemaVersion 2 is not supported/);
  });
});

describe("勿扰端到端（#44 的 Runtime 层）", () => {
  it("勿扰状态可查询、可切换并持久化跨重启", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maneki-rt-dnd-"));
    tempDirs.push(dir);
    const first = await startRuntime({ configDir: dir, log: () => undefined });
    runtimes.push(first);
    const pair = await jsonFetch(`http://127.0.0.1:${first.port}`, "/v1/pair", {
      token: first.rootToken,
      body: { name: "shell", scopes: "express" },
    });
    const token = (pair.body as { token: string }).token;
    expect((await jsonFetch(`http://127.0.0.1:${first.port}`, "/v1/dnd", { token })).body.enabled).toBe(false);
    await jsonFetch(`http://127.0.0.1:${first.port}`, "/v1/dnd", { token, body: { enabled: true } });
    expect((await jsonFetch(`http://127.0.0.1:${first.port}`, "/v1/dnd", { token })).body.enabled).toBe(true);
    await first.stop();

    const second = await startRuntime({ configDir: dir, log: () => undefined });
    runtimes.push(second);
    expect((await jsonFetch(`http://127.0.0.1:${second.port}`, "/v1/dnd", { token })).body.enabled).toBe(true);
  });
});
