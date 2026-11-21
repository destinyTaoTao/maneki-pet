import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createBriefingClient } from "@maneki-pet/sdk";
import { expect, it } from "vitest";
import { startRuntime } from "../../runtime/dist/runtime.js";
import { openAdminSession } from "../../runtime/dist/admin-session.js";

const run = promisify(execFile);
const pairing = join(import.meta.dirname, "../../runtime/scripts/pair-briefing-client.mjs");
const cli = join(import.meta.dirname, "../dist/main.js");
const bridge = join(import.meta.dirname, "../dist/briefing-mcp.js");

it("独立进程读到同一份到期待办与 dsh 等待会话；撤销立即影响已连接的桥", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maneki-work-briefing-"));
  const runtime = await startRuntime({ configDir: directory });
  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const mcp = new Client({ name: "briefing-acceptance", version: "1" });
  const grant = (name: string, ...flags: string[]) => run(process.execPath,
    [pairing, directory, String(runtime.port), name, ...flags], { windowsHide: true, timeout: 8000 });
  try {
    await expect(grant("agent")).rejects.toMatchObject({ code: 2 });
    expect(existsSync(join(directory, "briefing-client-agent.json"))).toBe(false);
    const { stdout } = await grant("agent", "--allow-briefing-read");
    const tokenFile = stdout.trim();
    expect(tokenFile).toBe(join(directory, "briefing-client-agent.json"));
    expect((await grant("agent", "--allow-briefing-read")).stdout).toBe(stdout);
    const sdk = createBriefingClient({ baseUrl, tokenFile });
    const before = await sdk.getBriefing();
    expect(before).toMatchObject({ todos: [], waiting: [], onlineSources: 0, offlineSources: 0 });

    // 仅在临时库中为数据生产者分别配对。三个消费者只收到简报客户端的文件。
    const admin = await openAdminSession(directory, runtime.port);
    async function producer(name: string, scope: string) {
      const paired = await admin.request("/v1/pair", { name, scopes: scope });
      if (paired.status !== 200 || typeof paired.body.token !== "string" || typeof paired.body.clientId !== "string") {
        throw new Error("fixture pairing failed");
      }
      return { token: paired.body.token, clientId: paired.body.clientId };
    }
    const assistant = await producer("personal-shell", "assistant");
    const observer = await producer("dsh-fixture", "express");
    const createTodo = await admin.request("/v1/assistant/mutations", {
      requestId: "fixture-todo", action: "todo.create", title: "核对交付清单", notes: "个人备注仅助手可见", dueDate: before.date,
    }, assistant.token);
    expect(createTodo.status).toBe(200);
    const sourceId = randomUUID(), observedAt = Date.now();
    const report = { sourceId, profileId: "work", reportSequence: 1, connected: true, truncated: false,
      sessions: [
        { sessionId: "A", projectName: "project-a", phase: "waiting_input", sequence: 1, observedAt },
        { sessionId: "B", projectName: "project-b", phase: "completed", sequence: 2, observedAt },
      ],
    };
    expect((await admin.request("/v1/observations/sessions", report, observer.token)).status).toBe(202);
    const expected = { ...before, todos: [{ title: "核对交付清单", dueDate: before.date }], onlineSources: 1,
      waiting: [{ clientId: observer.clientId, profileId: "work", sourceId, projectName: "project-a", sessionId: "A", observedAt }],
    };
    expect(await sdk.getBriefing()).toEqual(expected);
    const env = { MANEKI_RUNTIME_URL: baseUrl, MANEKI_BRIEFING_TOKEN_FILE: tokenFile };
    const command = await run(process.execPath, [cli, "briefing"], { env, timeout: 8000, windowsHide: true });
    expect(JSON.parse(command.stdout)).toEqual(expected);
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [bridge], env, stderr: "pipe" }));
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(["maneki_get_briefing"]);
    const read = () => mcp.callTool({ name: "maneki_get_briefing", arguments: {} });
    const first = await read();
    expect(first.content).toEqual([{ type: "text", text: expect.any(String) }]);
    const content = first.content as Array<{ text: string }>;
    expect(JSON.parse(content[0]!.text)).toEqual(expected);
    expect((await mcp.callTool({ name: "maneki_get_briefing", arguments: { includeNotes: true } })).isError).toBe(true);
    expect((await admin.request("/v1/observations/sessions", { ...report, connected: false, reportSequence: 2 }, observer.token)).status).toBe(202);
    expect(await sdk.getBriefing()).toMatchObject({ onlineSources: 0, offlineSources: 1, waiting: [], todos: expected.todos });
    const otherFile = (await grant("other", "--allow-briefing-read")).stdout.trim();
    const otherSdk = createBriefingClient({ baseUrl, tokenFile: otherFile });
    copyFileSync(otherFile, tokenFile);
    await expect(grant("agent", "--allow-briefing-read")).rejects.toMatchObject({ code: 1 });
    unlinkSync(tokenFile);
    await expect(grant("agent", "--allow-briefing-read")).rejects.toMatchObject({ code: 1 });
    await grant("agent", "--revoke-briefing-read");
    await grant("agent", "--revoke-briefing-read");
    expect((await read()).isError).toBe(true);
    await expect(sdk.getBriefing()).rejects.toThrow();
    expect(await otherSdk.getBriefing()).toMatchObject({ todos: expected.todos });
    await expect(grant("agent", "--allow-briefing-read")).rejects.toMatchObject({ code: 1 });
    expect(runtime.state()).toBe("ready");
  } finally {
    try { await mcp.close(); } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 30_000);
