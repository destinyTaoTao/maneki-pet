import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { openAdminSession } from "../src/admin-session.js";
import { runtimeIdentityProof } from "../src/auth.js";
import { RELEASE_VERSION } from "../src/release-version.js";

const root = "synthetic-review-root";
const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void, port = 0) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, port: (server.address() as { port: number }).port };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "maneki-admin-session-"));
  directories.push(directory);
  writeFileSync(join(directory, "root-token"), root);
  const authenticated: Array<{ path: string | undefined; token: string | undefined; verifiedSocket: boolean }> = [];
  const verified = new WeakSet<Socket>();
  const behavior = { instanceId: "trusted-instance", version: RELEASE_VERSION, closeHealth: false, response: "{}", status: 200, stall: false, disconnect: false };
  const { server, port } = await listen((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/health") {
      verified.add(req.socket);
      if (behavior.closeHealth) res.setHeader("connection", "close");
      res.end(JSON.stringify({ protocolVersion: 1, instanceId: behavior.instanceId, version: behavior.version,
        identityProof: runtimeIdentityProof(root, String(req.headers["x-maneki-challenge"]), 1, behavior.instanceId, port) }));
      return;
    }
    authenticated.push({ path: req.url, token: req.headers.authorization, verifiedSocket: verified.has(req.socket) });
    // 每次管理请求都要重新验证，不能沿用上一笔请求的连接身份。
    verified.delete(req.socket);
    req.resume();
    if (behavior.disconnect) { res.destroy(); return; }
    if (behavior.stall) return;
    res.writeHead(behavior.status, behavior.status === 302 ? { location: "/redirect-target" } : {});
    res.end(behavior.response);
  });
  return { directory, server, port, behavior, authenticated };
}

it("每次管理请求在同一条已验证连接上发送，并保留显式客户端凭证和 HTTP 错误响应", async () => {
  const { directory, port, behavior, authenticated } = await fixture();
  const session = await openAdminSession(directory, port);
  expect(await session.request("/v1/clients")).toEqual({ status: 200, body: {} });
  behavior.status = 403;
  behavior.response = JSON.stringify({ error: "scope required" });
  expect(await session.request("/v1/pair", { name: "test", scopes: "express" }, "client-token"))
    .toEqual({ status: 403, body: { error: "scope required" } });
  expect(authenticated).toEqual([
    { path: "/v1/clients", token: `Bearer ${root}`, verifiedSocket: true },
    { path: "/v1/pair", token: "Bearer client-token", verifiedSocket: true },
  ]);
});

it("端口在初次身份校验后易主时不向新监听者发送 root", async () => {
  const { directory, server, port } = await fixture();
  const session = await openAdminSession(directory, port);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const received: Array<string | undefined> = [];
  await listen((req, res) => {
    received.push(req.headers.authorization);
    res.end(JSON.stringify({ protocolVersion: 1, instanceId: "replacement", version: RELEASE_VERSION, identityProof: "0".repeat(64) }));
  }, port);
  await expect(session.request("/v1/pair", { name: "test", scopes: "express" })).rejects.toMatchObject({ code: "identity_mismatch" });
  expect(received).toEqual([undefined]);
});

it("health 关闭连接后拒绝在另一条 TCP 连接上发送凭证", async () => {
  const { directory, port, behavior, authenticated } = await fixture();
  const session = await openAdminSession(directory, port);
  behavior.closeHealth = true;
  await expect(session.request("/v1/clients")).rejects.toMatchObject({ code: "identity_mismatch" });
  expect(authenticated).toEqual([]);
});

it("后续请求拒绝持有同一密钥但实例 ID 已改变的服务", async () => {
  const { directory, port, behavior, authenticated } = await fixture();
  const session = await openAdminSession(directory, port);
  behavior.instanceId = "different-instance";
  await expect(session.request("/v1/clients")).rejects.toMatchObject({ code: "identity_mismatch" });
  expect(authenticated).toEqual([]);
});

it("每次管理请求重新检查发行版本，失败时不发送凭证", async () => {
  const { directory, port, behavior, authenticated } = await fixture();
  const session = await openAdminSession(directory, port);
  behavior.version = "0.1.0";
  await expect(session.request("/v1/clients")).rejects.toMatchObject({ code: "protocol_mismatch" });
  expect(authenticated).toEqual([]);
});

it.each(["[]", "null", "not-json", JSON.stringify({ value: "x".repeat(16384) })])("管理响应拒绝无效或超限 JSON（%#）", async (response) => {
  const { directory, port, behavior } = await fixture();
  const session = await openAdminSession(directory, port);
  behavior.response = response;
  await expect(session.request("/v1/clients")).rejects.toMatchObject({ code: "protocol_mismatch" });
});

it("管理请求不跟随重定向", async () => {
  const { directory, port, behavior, authenticated } = await fixture();
  const session = await openAdminSession(directory, port);
  behavior.status = 302;
  await expect(session.request("/v1/clients")).rejects.toMatchObject({ code: "runtime_unavailable" });
  expect(authenticated.map((entry) => entry.path)).toEqual(["/v1/clients"]);
});

it("管理请求超时后拒绝并释放专用连接", async () => {
  const { directory, server, port, behavior } = await fixture();
  const session = await openAdminSession(directory, port);
  behavior.stall = true;
  await expect(session.request("/v1/clients")).rejects.toMatchObject({ code: "timeout" });
  await vi.waitFor(async () => {
    const count = await new Promise<number>((resolve, reject) => server.getConnections((error, connections) => error ? reject(error) : resolve(connections)));
    expect(count).toBe(0);
  });
});

it("已验证连接的传输错误只返回固定错误，不产生未处理 socket 异常", async () => {
  const { directory, port, behavior } = await fixture();
  const session = await openAdminSession(directory, port);
  behavior.disconnect = true;
  await expect(session.request("/v1/clients")).rejects.toMatchObject({ code: "runtime_unavailable" });
});
