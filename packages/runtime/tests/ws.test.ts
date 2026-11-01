import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { connect as connectTcp } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { startRuntime, type StartedRuntime } from "../src/index.js";

const runtimes: StartedRuntime[] = [];
const tempDirs: string[] = [];

async function makeRuntime(): Promise<{ runtime: StartedRuntime; clientToken: string }> {
  const dir = mkdtempSync(join(tmpdir(), "maneki-rt-ws-"));
  tempDirs.push(dir);
  const runtime = await startRuntime({ configDir: dir, log: () => undefined, wsAuthTimeoutMs: 400 });
  runtimes.push(runtime);
  const pairResponse = await fetch(`http://127.0.0.1:${runtime.port}/v1/pair`, {
    method: "POST",
    headers: { authorization: `Bearer ${runtime.rootToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "shell", scopes: "express" }),
  });
  const pair = (await pairResponse.json()) as { token: string };
  return { runtime, clientToken: pair.token };
}

async function issueTicket(base: string, token: string): Promise<string> {
  const response = await fetch(`${base}/v1/ws-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as { ticket: string };
  return body.ticket;
}

interface ClientEvents {
  messages: Array<Record<string, unknown>>;
  closeCode: number | null;
  closed: Promise<number>;
}

function connect(url: string, firstMessage?: string): ClientEvents {
  const ws = new WebSocket(url);
  const messages: Array<Record<string, unknown>> = [];
  let closeCode: number | null = null;
  let resolveClosed: (code: number) => void = () => undefined;
  const closed = new Promise<number>((resolve) => {
    resolveClosed = resolve;
  });
  ws.addEventListener("open", () => {
    if (firstMessage !== undefined) {
      ws.send(firstMessage);
    }
  });
  ws.addEventListener("message", (event) => {
    messages.push(JSON.parse(event.data as string) as Record<string, unknown>);
  });
  ws.addEventListener("close", (event) => {
    closeCode = event.code;
    resolveClosed(event.code);
  });
  return { messages, closeCode, closed, socket: ws } as ClientEvents & { socket: WebSocket };
}

function socketOf(client: ClientEvents): WebSocket {
  return (client as ClientEvents & { socket: WebSocket }).socket;
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("WS 一次性票据鉴权", () => {
  it("畸形帧和随后洪泛只关闭当前连接", async () => {
    const { runtime } = await makeRuntime();
    const socket = connectTcp(runtime.port, "127.0.0.1");
    socket.on("error", () => undefined);
    try {
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.write(`GET /v1/events HTTP/1.1\r\nHost: 127.0.0.1:${runtime.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
      await new Promise<void>((resolve) => socket.once("data", () => resolve()));
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      socket.write(Buffer.concat([Buffer.from([0x81, 0]), Buffer.alloc(256 * 1024)]));
      await Promise.race([closed, new Promise<void>((_, reject) => setTimeout(() => reject(new Error("socket not closed")), 2000))]);
      expect((await fetch(`http://127.0.0.1:${runtime.port}/v1/health`)).status).toBe(200);
    } finally { socket.destroy(); }
  });
  it("单次写入合并多个合法大帧时连接仍可接收广播", async () => {
    const { runtime, clientToken } = await makeRuntime();
    const ticket = await issueTicket(`http://127.0.0.1:${runtime.port}`, clientToken);
    const socket = connectTcp(runtime.port, "127.0.0.1");
    let received = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => { received = Buffer.concat([received, chunk]); });
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      const deadline = Date.now() + 2000;
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(predicate()).toBe(true);
    };
    const frame = (text: string): Buffer => {
      const payload = Buffer.from(text);
      const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0xfe, payload.length >> 8, payload.length & 255]);
      return Buffer.concat([header, Buffer.alloc(4), payload]);
    };
    try {
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.write(`GET /v1/events HTTP/1.1\r\nHost: 127.0.0.1:${runtime.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
      await waitFor(() => received.includes(Buffer.from("101 Switching Protocols")));
      socket.write(frame(JSON.stringify({ type: "auth", ticket })));
      await waitFor(() => received.includes(Buffer.from('"ready"')));
      socket.write(Buffer.concat([frame("a".repeat(60000)), frame("b".repeat(10000))]));
      await new Promise((resolve) => setTimeout(resolve, 100));
      runtime.feed.publish("coalesced.test", {});
      await waitFor(() => received.includes(Buffer.from("coalesced.test")));
    } finally { socket.destroy(); }
  });
  it("拒绝错误 Host 和 Origin 的升级请求", async () => {
    const { runtime } = await makeRuntime();
    for (const headers of [{ host: "evil.example" }, { origin: "https://evil.example" }]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: runtime.port, path: "/v1/events", headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers } });
        req.on("response", (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on("upgrade", (_res, socket) => { socket.destroy(); resolve(101); });
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(403);
    }
  });

  it("拒绝超额首帧且服务保持健康", async () => {
    const { runtime } = await makeRuntime();
    const client = connect(`ws://127.0.0.1:${runtime.port}/v1/events`, "x".repeat(65537));
    expect(await Promise.race([client.closed, delay(2000)])).not.toBe(-1);
    expect((await fetch(`http://127.0.0.1:${runtime.port}/v1/health`)).status).toBe(200);
  });

  it("非对象及损坏的认证消息只关闭当前连接", async () => {
    const { runtime } = await makeRuntime();
    for (const message of ["null", "[]", "42", '"text"', "{"]) {
      const client = connect(`ws://127.0.0.1:${runtime.port}/v1/events`, message);
      expect(await Promise.race([client.closed, delay(2000)])).toBe(4001);
    }
    expect((await fetch(`http://127.0.0.1:${runtime.port}/v1/health`)).status).toBe(200);
  });

  it("未认证连接计入连接上限，释放后可再次连接", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maneki-rt-ws-limit-"));
    tempDirs.push(dir);
    const runtime = await startRuntime({ configDir: dir, log: () => undefined, wsAuthTimeoutMs: 10000 });
    runtimes.push(runtime);
    const clients: WebSocket[] = [];
    try {
      for (let i = 0; i < 64; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${runtime.port}/v1/events`);
        clients.push(ws);
        await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("connection rejected early")); });
      }
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: runtime.port, path: "/v1/events", headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
        req.on("response", (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on("upgrade", (_res, socket) => { socket.destroy(); resolve(101); });
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(503);
      const first = clients[0]!;
      await new Promise<void>((resolve) => { first.onclose = () => resolve(); first.close(); });
      const replacement = new WebSocket(`ws://127.0.0.1:${runtime.port}/v1/events`);
      clients.push(replacement);
      await new Promise<void>((resolve, reject) => { replacement.onopen = () => resolve(); replacement.onerror = () => reject(new Error("replacement rejected")); });
    } finally {
      for (const client of clients) client.close();
    }
  }, 20000);
  it("有效票据认证后收到 ready，并收到订阅的事件广播", async () => {
    const { runtime, clientToken } = await makeRuntime();
    const base = `http://127.0.0.1:${runtime.port}`;
    const ticket = await issueTicket(base, clientToken);
    const client = connect(`ws://127.0.0.1:${runtime.port}/v1/events`, JSON.stringify({ type: "auth", ticket }));
    await expect(
      Promise.race([
        new Promise<void>((resolve, reject) => {
          const timer = setInterval(() => {
            if (client.messages.some((message) => message.type === "ready")) {
              clearInterval(timer);
              resolve();
            }
          }, 20);
          setTimeout(() => reject(new Error("no ready message")), 2_000);
        }),
      ]),
    ).resolves.toBeUndefined();

    runtime.feed.publish("test.broadcast", { hello: 1 });
    await expect(
      new Promise<void>((resolve, reject) => {
        const timer = setInterval(() => {
          const event = client.messages.find((message) => message.type === "event") as
            | { event?: { kind?: string } }
            | undefined;
          if (event?.event?.kind === "test.broadcast") {
            clearInterval(timer);
            resolve();
          }
        }, 20);
        setTimeout(() => reject(new Error("no broadcast received")), 2_000);
      }),
    ).resolves.toBeUndefined();
    socketOf(client).close();
  });

  it("同一票据重放被拒绝关闭（4001）", async () => {
    const { runtime, clientToken } = await makeRuntime();
    const base = `http://127.0.0.1:${runtime.port}`;
    const ticket = await issueTicket(base, clientToken);

    const first = connect(`ws://127.0.0.1:${runtime.port}/v1/events`, JSON.stringify({ type: "auth", ticket }));
    await clientWaitReady(first);
    const second = connect(`ws://127.0.0.1:${runtime.port}/v1/events`, JSON.stringify({ type: "auth", ticket }));
    const code = await Promise.race([second.closed, delay(2_000).then(() => -1)]);
    expect(code).toBe(4001);
    socketOf(first).close();
  });

  it("超时未认证被关闭（4001）", async () => {
    const { runtime } = await makeRuntime();
    const client = connect(`ws://127.0.0.1:${runtime.port}/v1/events`);
    const code = await Promise.race([client.closed, delay(2_000).then(() => -1)]);
    expect(code).toBe(4001);
  });

  it("无效票据认证被拒绝（4001）", async () => {
    const { runtime } = await makeRuntime();
    const client = connect(`ws://127.0.0.1:${runtime.port}/v1/events`, JSON.stringify({ type: "auth", ticket: "bogus" }));
    const code = await Promise.race([client.closed, delay(2_000).then(() => -1)]);
    expect(code).toBe(4001);
  });
});

function delay(ms: number): Promise<number> {
  return new Promise((resolve) => setTimeout(() => resolve(-1), ms));
}

function clientWaitReady(client: ClientEvents): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (client.messages.some((message) => message.type === "ready")) {
        clearInterval(timer);
        resolve();
      }
    }, 20);
    setTimeout(() => {
      clearInterval(timer);
      reject(new Error("no ready message"));
    }, 2_000);
  });
}
