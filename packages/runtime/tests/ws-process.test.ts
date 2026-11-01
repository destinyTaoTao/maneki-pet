import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("异常首帧只关闭该连接，独立 Runtime 与受信客户端继续工作", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maneki-ws-process-"));
  const child = spawn(process.execPath, [join(import.meta.dirname, "../dist/cli.js"), "--config-dir", dir], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    const deadline = Date.now() + 10000;
    while (!/ready: port=(\d+)/.test(stderr) && Date.now() < deadline && child.exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const port = Number(/ready: port=(\d+)/.exec(stderr)?.[1]);
    expect(port, stderr).toBeGreaterThan(0);
    const base = `http://127.0.0.1:${port}`;
    const root = readFileSync(join(dir, "root-token"), "utf8").trim();
    const paired = await fetch(`${base}/v1/pair`, { method: "POST", headers: { authorization: `Bearer ${root}`, "content-type": "application/json" }, body: JSON.stringify({ name: "test", scopes: "express" }) });
    const { token } = await paired.json() as { token: string };
    const ticketResponse = await fetch(`${base}/v1/ws-ticket`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const { ticket } = await ticketResponse.json() as { ticket: string };
    const valid = new WebSocket(`ws://127.0.0.1:${port}/v1/events`);
    await new Promise<void>((resolve, reject) => { valid.onopen = () => valid.send(JSON.stringify({ type: "auth", ticket })); valid.onmessage = () => resolve(); valid.onerror = () => reject(new Error("valid connection failed")); });
    const bad = new WebSocket(`ws://127.0.0.1:${port}/v1/events`);
    await new Promise<void>((resolve) => { bad.onopen = () => bad.send("null"); bad.onclose = () => resolve(); });
    expect(child.exitCode, stderr).toBeNull();
    expect((await fetch(`${base}/v1/health`)).status).toBe(200);
    expect(valid.readyState).toBe(WebSocket.OPEN);
    valid.close();
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.exitCode !== null ? resolve() : child.once("exit", () => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
