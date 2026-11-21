import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createReminderClient, createReminderReadClient, createReminderRescheduleClient } from "@maneki-pet/sdk";
import { expect, it } from "vitest";
import { startRuntime } from "../../runtime/dist/runtime.js";

const run = promisify(execFile);
const scripts = join(import.meta.dirname, "../../runtime/scripts");
const dist = join(import.meta.dirname, "../dist");

it("SDK、CLI 和 MCP 并发改期只更新同一条记录，撤销只影响改期", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maneki-reminder-reschedule-"));
  const runtime = await startRuntime({ configDir: directory });
  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const host = new Client({ name: "reminder-rescheduler", version: "1" });
  const pair = async (capability: string, flag: string) => (await run(process.execPath,
    [join(scripts, `pair-${capability}-client.mjs`), directory, String(runtime.port), "host", flag],
    { windowsHide: true, timeout: 8000 })).stdout.trim();
  try {
    await expect(pair("reminder-reschedule", "--allow-reminder-reschedule")).rejects.toMatchObject({ code: 1 });
    const tokenFile = await pair("reminder", "--allow-reminder-create");
    const readerFile = await pair("reminder-read", "--allow-reminder-read");
    const rescheduleFile = await pair("reminder-reschedule", "--allow-reminder-reschedule");
    expect(await pair("reminder-reschedule", "--allow-reminder-reschedule")).toBe(rescheduleFile);
    const creator = createReminderClient({ baseUrl, tokenFile });
    const reader = createReminderReadClient({ baseUrl, tokenFile: readerFile });
    const rescheduler = createReminderRescheduleClient({ baseUrl, tokenFile: rescheduleFile });
    const create = (afterSeconds: number) => creator.createReminder({ requestId: randomUUID(), afterSeconds, message: "休息" });
    const keep = await create(1200);
    const target = await create(1800);
    const listed = await reader.listReminders();
    const [keepRow, targetRow] = listed.reminders;
    expect([keepRow?.reminderId, targetRow?.reminderId]).toEqual([keep.reminderId, target.reminderId]);
    const input = { requestId: randomUUID(), reminderId: target.reminderId, version: targetRow!.version, afterSeconds: 3600 };
    const env = { MANEKI_RUNTIME_URL: baseUrl, MANEKI_REMINDER_RESCHEDULE_TOKEN_FILE: rescheduleFile };
    await host.connect(new StdioClientTransport({ command: process.execPath, args: [join(dist, "reminder-reschedule-mcp.js")], env }));
    expect((await host.listTools()).tools.map(tool => tool.name)).toEqual(["maneki_reschedule_reminder"]);
    const call = (args: Record<string, unknown>) => host.callTool({ name: "maneki_reschedule_reminder", arguments: args });
    expect((await call({ message: "休息", afterSeconds: 3600 })).isError).toBe(true);
    const started = Date.now();
    const [receipt, tool, command] = await Promise.all([
      rescheduler.rescheduleReminder(input),
      call(input),
      run(process.execPath, [join(dist, "main.js"), "reschedule-reminder", "--request-id", input.requestId, "--reminder-id",
        input.reminderId, "--version", String(input.version), "--after-seconds", "3600"], { env, timeout: 8000, windowsHide: true }),
    ]);
    expect(tool.isError).not.toBe(true);
    expect(JSON.parse((tool.content as { text: string }[])[0]!.text)).toEqual(receipt);
    expect(JSON.parse(command.stdout)).toEqual(receipt);
    expect(receipt).toMatchObject({ requestId: input.requestId, reminderId: target.reminderId, version: input.version + 1 });
    expect(receipt.remindAt).toBeGreaterThanOrEqual(started + 3_600_000);
    expect(receipt.remindAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
    await expect(rescheduler.rescheduleReminder({ ...input, reminderId: keep.reminderId, version: keepRow!.version })).rejects.toThrow(/409/);
    await expect(rescheduler.rescheduleReminder({ ...input, requestId: randomUUID() })).rejects.toThrow(/409/);
    await pair("reminder-reschedule", "--revoke-reminder-reschedule");
    expect((await call(input)).isError).toBe(true);
    expect(await reader.listReminders()).toEqual({ reminders: [keepRow,
      { reminderId: target.reminderId, message: "休息", remindAt: receipt.remindAt, version: receipt.version }] });
    expect(runtime.store.assistantStore().reminders()).toHaveLength(2);
  } finally {
    try { await host.close(); } finally {
      await runtime.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 30_000);
