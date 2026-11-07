import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { startRuntime, type StartedRuntime } from "../src/index.js";

const exec = promisify(execFile);
const cli = join(import.meta.dirname, "../dist/cli.js");
const dirs: string[] = [];
const runtimes: StartedRuntime[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), "maneki-manager-")); dirs.push(dir); return dir; }
function manage(dir: string, port: number, action: string, client = "web") {
  return exec(process.execPath, [cli, "--config-dir", dir, "--port", String(port), "--assistant-manager", action, "--client", client], { timeout: 25_000 });
}
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("两个 profile 并发连接共享一个 Runtime，首次不自动授权，撤销后不能静默重配", async () => {
  const dir = directory();
  const runtime = await startRuntime({ configDir: dir }); runtimes.push(runtime);
  await expect(manage(dir, runtime.port, "connect")).rejects.toMatchObject({ stdout: '{"error":"pairing_required"}' });
  expect(runtime.store.listClients()).toHaveLength(1);
  const paired = await Promise.all([manage(dir, runtime.port, "pair"), manage(dir, runtime.port, "pair", "work")]);
  const tokens = paired.map((result) => (JSON.parse(result.stdout) as { token: string }).token);
  expect(new Set(tokens).size).toBe(2);
  expect(paired.map((p) => p.stdout + p.stderr).join()).not.toContain(runtime.rootToken);
  const clients = runtime.store.listClients().filter((client) => client.clientId !== "root");
  expect(clients.map((client) => client.scopes)).toEqual([["express"], ["express"]]);
  for (const route of ["/v1/shutdown", "/v1/pair", "/v1/dnd"]) {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, { method: "POST", headers: { authorization: `Bearer ${tokens[0]}`, "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(403);
  }
  expect(JSON.parse((await manage(dir, runtime.port, "connect")).stdout)).toEqual({ state: "ready", token: tokens[0] });
  const web = clients.find((client) => client.name === "dsh-web")!;
  runtime.store.revokeClient(web.clientId, new Date().toISOString());
  await expect(manage(dir, runtime.port, "pair")).rejects.toMatchObject({ stdout: '{"error":"credential_rejected"}' });
  expect(runtime.store.listClients()).toHaveLength(3);
});

it("无窗口按需启动、并发复用、管理调用退出后后台仍在，明确退出释放端口和实例锁", async () => {
  const dir = directory();
  const portServer = createServer();
  await new Promise<void>((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  try {
    expect(JSON.parse((await manage(dir, port, "status")).stdout)).toEqual({ state: "stopped" });
    expect(existsSync(join(dir, "runtime.db"))).toBe(false);
    const results = await Promise.allSettled([manage(dir, port, "connect"), manage(dir, port, "connect", "work")]);
    expect(results.every((r) => r.status === "rejected" && r.reason.stdout === '{"error":"pairing_required"}')).toBe(true);
    const holder = readFileSync(join(dir, "runtime.lock"), "utf8");
    const first = await manage(dir, port, "pair");
    expect(JSON.parse(first.stdout).state).toBe("ready");
    expect(readFileSync(join(dir, "runtime.lock"), "utf8")).toBe(holder);
    expect(JSON.parse((await manage(dir, port, "status")).stdout).state).toBe("ready");
    const result = await manage(dir, port, "quit");
    expect(JSON.parse(result.stdout)).toEqual({ state: "stopped" });
    expect(existsSync(join(dir, "runtime.lock"))).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/v1/health`)).rejects.toThrow();
  } finally { await manage(dir, port, "quit").catch(() => undefined); }
}, 35_000);

it("服务冒充、非法 profile 或未知管理操作均不发送任何凭证", async () => {
  const dir = directory(); writeFileSync(join(dir, "root-token"), "private-root");
  const seen: Array<string | undefined> = [];
  const server = createServer((req, res) => { seen.push(req.headers.authorization); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ protocolVersion: 1, instanceId: "fake", identityProof: "0".repeat(64) })); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await expect(manage(dir, port, "pair")).rejects.toMatchObject({ stdout: '{"error":"identity_mismatch"}' });
    expect(seen).toEqual([undefined]);
    await expect(manage(dir, port, "pair", "../root")).rejects.toMatchObject({ stdout: '{"error":"invalid_config"}' });
    await expect(manage(dir, port, "execute")).rejects.toMatchObject({ stdout: '{"error":"invalid_config"}' });
    expect(seen).toHaveLength(1);
    expect(existsSync(join(dir, "runtime.db"))).toBe(false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
