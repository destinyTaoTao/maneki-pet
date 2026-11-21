import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createReminderCancelClient, createReminderClient, createReminderReadClient } from "@maneki-pet/sdk";
import { expect, it } from "vitest";
import { startRuntime } from "../../runtime/dist/runtime.js";

const run = promisify(execFile);
const scripts = join(import.meta.dirname, "../../runtime/scripts");
const dist = join(import.meta.dirname, "../dist");

it("MCP 只公布获授权的操作，SDK 和 CLI 重试同一次取消时保留其余同名提醒", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maneki-reminder-management-"));
  const runtime = await startRuntime({ configDir: directory });
  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const listHost = new Client({ name: "management-reader", version: "1" });
  const cancelHost = new Client({ name: "management-canceller", version: "1" });
  const pair = async (capability: string, flag: string, name = "host") => (await run(process.execPath,
    [join(scripts, `pair-${capability}-client.mjs`), directory, String(runtime.port), name, flag],
    { windowsHide: true, timeout: 8000 })).stdout.trim();
  try {
    await expect(pair("reminder-read", "--allow-reminder-read")).rejects.toMatchObject({ code: 1 });
    const tokenFile = await pair("reminder", "--allow-reminder-create");
    const readerFile = await pair("reminder-read", "--allow-reminder-read");
    const cancelFile = await pair("reminder-cancel", "--allow-reminder-cancel");
    const creator = createReminderClient({ baseUrl, tokenFile });
    const reader = createReminderReadClient({ baseUrl, tokenFile: readerFile });
    const canceller = createReminderCancelClient({ baseUrl, tokenFile: cancelFile });
    const create = () => creator.createReminder({ requestId: randomUUID(), afterSeconds: 1800, message: "休息" });
    const other = createReminderClient({ baseUrl, tokenFile: await pair("reminder", "--allow-reminder-create", "another") });
    const hidden = await other.createReminder({ requestId: randomUUID(), afterSeconds: 1800, message: "另一个调用方的私人提醒" });
    const keep = await create();
    const target = await create();
    const env = { MANEKI_RUNTIME_URL: baseUrl, MANEKI_REMINDER_READ_TOKEN_FILE: readerFile, MANEKI_REMINDER_CANCEL_TOKEN_FILE: cancelFile };
    const cli = (args: string[]) => run(process.execPath, [join(dist, "main.js"), ...args], { env, timeout: 8000, windowsHide: true });
    await Promise.all([listHost.connect(new StdioClientTransport({ command: process.execPath, args: [join(dist, "reminder-read-mcp.js")], env })),
      cancelHost.connect(new StdioClientTransport({ command: process.execPath, args: [join(dist, "reminder-cancel-mcp.js")], env }))]);
    expect((await listHost.listTools()).tools.map(tool => tool.name)).toEqual(["maneki_list_reminders"]);
    expect((await cancelHost.listTools()).tools.map(tool => tool.name)).toEqual(["maneki_cancel_reminder"]);
    const listed = await reader.listReminders();
    expect(listed.reminders.map(row => row.reminderId).sort()).toEqual([target.reminderId, keep.reminderId].sort());
    const read = await listHost.callTool({ name: "maneki_list_reminders", arguments: {} });
    expect(read.content).toEqual([{ type: "text", text: expect.any(String) }]);
    expect(JSON.parse((read.content as { text: string }[])[0]!.text)).toEqual(listed);
    expect(JSON.parse((await cli(["reminders"])).stdout)).toEqual(listed);

    const selected = listed.reminders.find(row => row.reminderId === target.reminderId)!;
    const input = { requestId: randomUUID(), reminderId: selected.reminderId, version: selected.version };
    const call = (args: Record<string, unknown>) => cancelHost.callTool({ name: "maneki_cancel_reminder", arguments: args });
    expect((await call({ message: "休息" })).isError).toBe(true);
    await expect(canceller.cancelReminder({ ...input, reminderId: hidden.reminderId })).rejects.toThrow(/404/);
    const result = await call(input);
    expect(result.isError).not.toBe(true);
    const expected = { requestId: input.requestId, reminderId: target.reminderId, cancelled: true };
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(expected);
    expect(await canceller.cancelReminder(input)).toEqual(expected);
    expect(JSON.parse((await cli(["cancel-reminder", "--request-id", input.requestId, "--reminder-id", input.reminderId,
      "--version", String(input.version)])).stdout)).toEqual(expected);
    await expect(canceller.cancelReminder({ ...input, reminderId: keep.reminderId })).rejects.toThrow(/409/);
    await pair("reminder-cancel", "--revoke-reminder-cancel");
    expect((await call(input)).isError).toBe(true);
    expect((await reader.listReminders()).reminders.map(row => row.reminderId)).toEqual([keep.reminderId]);
    expect(runtime.store.assistantStore().reminders().map(item => item.id).sort()).toEqual([keep.reminderId, hidden.reminderId].sort());
  } finally {
    try { await Promise.all([listHost.close(), cancelHost.close()]); } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 30_000);
