import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";

it("HTTP 来源与真实 stdio MCP 共用仲裁、WS 和快照，MCP idle 不能覆盖宿主等待", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maneki-expression-http-"));
  const client = new Client({ name: "test-expression", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["tests/fixtures/expression-mcp-runtime.mjs", dir], stderr: "pipe" });
  let socket: WebSocket | undefined;
  try {
    await client.connect(transport);
    const base = `http://127.0.0.1:${readFileSync(join(dir, "port"), "utf8")}`;
    const rootToken = readFileSync(join(dir, "root-token"), "utf8").trim();
    const pairResponse = await fetch(`${base}/v1/pair`, { method: "POST", headers: { authorization: `Bearer ${rootToken}`, "content-type": "application/json" }, body: JSON.stringify({ name: "observer", scopes: "express,settings" }) });
    const { token } = await pairResponse.json() as { token: string };
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const ticketResponse = await fetch(`${base}/v1/ws-ticket`, { method: "POST", headers });
    const { ticket } = await ticketResponse.json() as { ticket: string };
    const states: string[] = [];
    let onBarrier = (): void => undefined;
    socket = new WebSocket(`ws://127.0.0.1:${base.split(":").at(-1)}/v1/events`);
    const ws = socket;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "auth", ticket })));
      ws.addEventListener("error", reject);
      ws.addEventListener("message", ({ data }) => {
        const message = JSON.parse(String(data)) as { type: string; event?: { kind: string; payload: { state?: string } } };
        if (message.type === "ready") resolve();
        if (message.event?.kind === "expression.state") states.push(message.event.payload.state!);
        if (message.event?.kind === "dnd.changed") onBarrier();
      });
    });
    const barrier = async (): Promise<void> => {
      const received = new Promise<void>((resolve) => { onBarrier = resolve; });
      await fetch(`${base}/v1/dnd`, { method: "POST", headers, body: JSON.stringify({ enabled: false }) });
      await received;
    };
    await fetch(`${base}/v1/expressions/state`, { method: "POST", headers, body: JSON.stringify({ sourceId: "00000000-0000-4000-8000-000000000001", state: "waiting_input" }) });
    await client.callTool({ name: "maneki_set_state", arguments: { state: "idle" } });
    await barrier();
    expect(states).toEqual(["waiting_input"]);
    expect(await (await fetch(`${base}/v1/expressions/state`, { headers })).json()).toEqual({ state: "waiting_input" });
  } finally {
    socket?.close();
    await client.close();
    await transport.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
