import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it } from "vitest";

import { startRuntime, type StartedRuntime } from "../src/index.js";

const dirs: string[] = [];
const runtimes: StartedRuntime[] = [];
const cli = join(import.meta.dirname, "../dist/cli.js");
const exec = promisify(execFile);

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("受信 sidecar 配对只返回最小客户端凭证，跨进程重用且不生成第二个助理", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maneki-desktop-credential-"));
  dirs.push(dir);
  const runtime = await startRuntime({ configDir: dir });
  runtimes.push(runtime);
  const args = [cli, "--config-dir", dir, "--port", String(runtime.port), "--desktop-credential"];
  const first = await exec(process.execPath, args, { timeout: 5000 });
  const credential = JSON.parse(first.stdout) as { token: string };
  expect(Object.keys(credential)).toEqual(["token"]);
  expect(first.stdout + first.stderr).not.toContain(runtime.rootToken);
  const headers = { authorization: `Bearer ${credential.token}`, "content-type": "application/json" };
  const base = `http://127.0.0.1:${runtime.port}`;
  expect((await fetch(`${base}/v1/dnd`, { method: "POST", headers, body: JSON.stringify({ enabled: true }) })).status).toBe(200);
  expect((await fetch(`${base}/v1/clients`, { headers })).status).toBe(403);
  const second = await exec(process.execPath, args, { timeout: 5000 });
  expect(JSON.parse(second.stdout)).toEqual(credential);
  const clients = await (await fetch(`${base}/v1/clients`, { headers: { authorization: `Bearer ${runtime.rootToken}` } })).json() as { clients: Array<{ scopes: string[] }> };
  expect(clients.clients).toHaveLength(2);
  expect(clients.clients.find((c) => !c.scopes.includes("admin"))?.scopes).toEqual(["express", "notify", "settings"]);
  expect(readFileSync(join(dir, "desktop-client.json"), "utf8")).not.toContain(runtime.rootToken);
  const paired = clients.clients.find((c) => !c.scopes.includes("admin")) as { clientId: string; scopes: string[] };
  await fetch(`${base}/v1/clients/${paired.clientId}/revoke`, { method: "POST", headers: { authorization: `Bearer ${runtime.rootToken}` } });
  await expect(exec(process.execPath, args, { timeout: 5000 })).rejects.toMatchObject({ code: 1, stdout: "" });
  const after = await (await fetch(`${base}/v1/clients`, { headers: { authorization: `Bearer ${runtime.rootToken}` } })).json() as { clients: unknown[] };
  expect(after.clients).toHaveLength(2);
  await runtime.stop();
  const restarted = await startRuntime({ configDir: dir, port: runtime.port });
  runtimes.push(restarted);
  await expect(exec(process.execPath, args, { timeout: 5000 })).rejects.toMatchObject({ code: 1, stdout: "" });
});

it("协议不匹配时管理模式不配对、不启动另一份助理", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maneki-desktop-version-"));
  dirs.push(dir);
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ protocolVersion: 2, instanceId: "wrong-version" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await expect(exec(process.execPath, [cli, "--config-dir", dir, "--port", String((server.address() as { port: number }).port), "--desktop-credential"], { timeout: 5000 })).rejects.toMatchObject({ code: 1, stdout: "" });
    expect(paths).toEqual(["/v1/health"]);
    expect((await import("node:fs")).existsSync(join(dir, "runtime.db"))).toBe(false);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
