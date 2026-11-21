import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createBriefingClient, createReminderClient } from "@maneki-pet/sdk";
import { expect, it } from "vitest";
import { startRuntime } from "../../runtime/dist/runtime.js";

const run = promisify(execFile);
const scripts = join(import.meta.dirname, "../../runtime/scripts");
const dist = join(import.meta.dirname, "../dist");

it("同一 agent 换入口重试仍返回首次回执；按名撤销不会影响已安排的提醒或独立简报授权", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maneki-reminder-client-"));
  const runtime = await startRuntime({ configDir: directory });
  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const host = new Client({ name: "reminder-fixture", version: "1" });
  const pair = (capability: "reminder" | "briefing", name: string, ...flags: string[]) =>
    run(process.execPath, [join(scripts, `pair-${capability}-client.mjs`), directory, String(runtime.port), name, ...flags],
      { windowsHide: true, timeout: 8000 });
  try {
    const expectedFile = join(directory, "reminder-client-host.json");
    await expect(pair("reminder", "host", "--allow-briefing-read")).rejects.toMatchObject({ code: 2 });
    expect(existsSync(expectedFile)).toBe(false);
    const briefFile = (await pair("briefing", "host", "--allow-briefing-read")).stdout.trim();
    const tokenFile = (await pair("reminder", "host", "--allow-reminder-create")).stdout.trim();
    expect(tokenFile).toBe(expectedFile);
    expect((await pair("reminder", "host", "--allow-reminder-create")).stdout.trim()).toBe(tokenFile);
    const agent = createReminderClient({ baseUrl, tokenFile });
    const briefing = createBriefingClient({ baseUrl, tokenFile: briefFile });
    const env = { MANEKI_RUNTIME_URL: baseUrl, MANEKI_REMINDER_TOKEN_FILE: tokenFile };
    await host.connect(new StdioClientTransport({ command: process.execPath, args: [join(dist, "reminder-mcp.js")], env, stderr: "pipe" }));
    expect((await host.listTools()).tools.map(tool => tool.name)).toEqual(["maneki_remind"]);
    const input = { requestId: randomUUID(), afterSeconds: 1800, message: "休息" };
    const invoke = () => host.callTool({ name: "maneki_remind", arguments: input });
    const started = Date.now();
    const [receipt, other, command] = await Promise.all([
      agent.createReminder(input),
      invoke(),
      run(process.execPath, [join(dist, "main.js"), "remind", "--request-id", input.requestId, "--after-seconds", "1800", "--message", "休息"],
        { env, windowsHide: true, timeout: 8000 }),
    ]);
    expect(other.isError).not.toBe(true);
    expect(other.content).toEqual([{ type: "text", text: expect.any(String) }]);
    expect(JSON.parse((other.content as { text: string }[])[0]!.text)).toEqual(receipt);
    expect(JSON.parse(command.stdout)).toEqual(receipt);
    expect(Object.keys(receipt).sort()).toEqual(["remindAt", "reminderId", "requestId"]);
    expect(receipt.requestId).toBe(input.requestId);
    expect(receipt.remindAt).toBeGreaterThanOrEqual(started + 1_800_000);
    expect(receipt.remindAt).toBeLessThanOrEqual(Date.now() + 1_800_000);
    await expect(agent.createReminder({ ...input, afterSeconds: 60 })).rejects.toThrow();
    // 管理端拒绝复用误放的简报文件；即使提醒文件随后丢失，仍可独立撤销。
    copyFileSync(briefFile, tokenFile);
    await expect(pair("reminder", "host", "--allow-reminder-create")).rejects.toMatchObject({ code: 1 });
    unlinkSync(tokenFile);
    await expect(pair("reminder", "host", "--allow-reminder-create")).rejects.toMatchObject({ code: 1 });
    await pair("reminder", "host", "--revoke-reminder-create");
    await pair("reminder", "host", "--revoke-reminder-create");
    expect((await invoke()).isError).toBe(true);
    await expect(briefing.getBriefing()).resolves.toMatchObject({ todos: [] });
    expect(runtime.store.assistantStore().reminders()).toMatchObject([{ id: receipt.reminderId, message: "休息", status: "pending", attempts: 0 }]);
  } finally {
    try { await host.close(); } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 30_000);
