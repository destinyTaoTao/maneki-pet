import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
