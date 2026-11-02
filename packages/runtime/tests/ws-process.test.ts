import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:net";
import { randomInt } from "node:crypto";
import { expect, it } from "vitest";

async function availableClientPort(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const server = createServer();
    const port = randomInt(20000, 60000);
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return port;
    } catch { server.close(); }
  }
  throw new Error("no available high test port");
}

it("异常首帧只关闭该连接，独立 Runtime 与受信客户端继续工作", async () => {
  const testPort = await availableClientPort();
  const dir = mkdtempSync(join(tmpdir(), "maneki-ws-process-"));
  const child = spawn(process.execPath, [join(import.meta.dirname, "../dist/cli.js"), "--config-dir", dir, "--port", String(testPort)], { stdio: ["ignore", "ignore", "pipe"] });
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
    const verifyEvents = async (): Promise<void> => {
      const event = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("healthy client stopped receiving events")), 2000);
        valid.onmessage = (message) => { clearTimeout(timer); resolve(JSON.parse(String(message.data))); };
      });
      expect((await fetch(`${base}/v1/dnd`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) })).status).toBe(200);
      await expect(event).resolves.toMatchObject({ type: "event", event: { kind: "dnd.changed", payload: { enabled: true } } });
    };
    for (const message of ["null", "[]", "42", "{", "x".repeat(65537)]) {
      const bad = new WebSocket(`ws://127.0.0.1:${port}/v1/events`);
      await new Promise<void>((resolve) => { bad.onopen = () => bad.send(message); bad.onclose = () => resolve(); });
      await verifyEvents();
    }
    await new Promise<void>((resolve, reject) => {
      const reset = connect(port, "127.0.0.1");
      reset.on("error", reject);
      reset.once("connect", () => reset.write(`GET /v1/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`));
      reset.once("data", () => reset.resetAndDestroy());
      reset.once("close", () => resolve());
    });
    await verifyEvents();
    const unauthenticated = new WebSocket(`ws://127.0.0.1:${port}/v1/events`);
    const timeoutCode = await new Promise<number>((resolve) => { unauthenticated.onclose = (event) => resolve(event.code); });
    expect(timeoutCode).toBe(4001);
    await verifyEvents();
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
