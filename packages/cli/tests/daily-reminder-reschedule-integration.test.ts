import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRecurringReminderClient, createRecurringReminderRescheduleClient } from "@maneki-pet/sdk";
import { expect, it, vi } from "vitest";
import { openAdminSession } from "../../runtime/dist/admin-session.js";
import { defaultAssistantSettings } from "../../runtime/dist/assistant-settings.js";
import { startRuntime } from "../../runtime/dist/runtime.js";

const run = promisify(execFile);
const scripts = join(import.meta.dirname, "../../runtime/scripts");
const dist = join(import.meta.dirname, "../dist");

it("每日改期凭证独立，SDK、CLI、MCP 重试只更新同一系列一次", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maneki-daily-reschedule-"));
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-21T00:00:00Z"));
  const runtime = await startRuntime({ configDir: directory });
  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const host = new Client({ name: "daily-reschedule-fixture", version: "1" });
  const pair = async (capability: string, flag: string, name = "host") => (await run(process.execPath,
    [join(scripts, `pair-${capability}-client.mjs`), directory, String(runtime.port), name, flag],
    { windowsHide: true, timeout: 8000 })).stdout.trim();
  try {
    const admin = await openAdminSession(directory, runtime.port);
    runtime.store.assistantStore().set("settings", JSON.stringify({ ...defaultAssistantSettings(), timeZone: "Asia/Shanghai" }));
    const recurring = "reminder-recurring";
    const rescheduling = "reminder-recurring-reschedule";
    await expect(pair(rescheduling, "--allow-reminder-recurring-reschedule")).rejects.toMatchObject({ code: 1 });
    const creatorFile = await pair(recurring, "--allow-reminder-recurring");
    const rescheduleFile = await pair(rescheduling, "--allow-reminder-recurring-reschedule");
    expect(await pair(rescheduling, "--allow-reminder-recurring-reschedule")).toBe(rescheduleFile);
    const token = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { token: string }).token;
    expect((await admin.request("/v1/recurring-reminders/reschedule/targets", undefined, token(creatorFile))).status).toBe(403);
    expect((await admin.request("/v1/recurring-reminders", undefined, token(rescheduleFile))).status).toBe(403);
    expect((await admin.request("/v1/pair", { name: "mixed", scopes: "reminder_recurring,reminder_recurring_reschedule" })).status).toBe(400);
    const creator = createRecurringReminderClient({ baseUrl, tokenFile: creatorFile });
    const other = createRecurringReminderClient({ baseUrl, tokenFile: await pair(recurring, "--allow-reminder-recurring", "other") });
    const client = createRecurringReminderRescheduleClient({ baseUrl, tokenFile: rescheduleFile });
    const input = () => ({ requestId: randomUUID(), localTime: "09:00", message: "休息" });
    const target = await creator.createDailyReminder(input());
    const keep = await creator.createDailyReminder(input());
    const hidden = await other.createDailyReminder({ ...input(), message: "独立身份" });
    const env = { MANEKI_RUNTIME_URL: baseUrl, MANEKI_REMINDER_RECURRING_RESCHEDULE_TOKEN_FILE: rescheduleFile };
    const cli = (...args: string[]) => run(process.execPath, [join(dist, "main.js"), ...args], { env, timeout: 8000, windowsHide: true });
    await host.connect(new StdioClientTransport({ command: process.execPath, args: [join(dist, "reminder-recurring-reschedule-mcp.js")], env }));
    expect((await host.listTools()).tools.map(tool => tool.name).sort()).toEqual(
      ["maneki_list_daily_reschedule_targets", "maneki_reschedule_daily_reminder"],
    );
    const targets = await client.listTargets();
    expect(targets.reminders.map(item => item.seriesId).sort()).toEqual([keep.seriesId, target.seriesId].sort());
    expect(JSON.parse((await cli("daily-reschedule-targets")).stdout)).toEqual(targets);
    const selection = targets.reminders.find(item => item.seriesId === target.seriesId)!;
    expect(selection.version).toBe(1);
    const request = { requestId: randomUUID(), seriesId: selection.seriesId, version: selection.version, localTime: "10:00" };
    await expect(client.rescheduleDailyReminder({ ...request, seriesId: hidden.seriesId })).rejects.toThrow(/404/);
    const invoke = () => host.callTool({ name: "maneki_reschedule_daily_reminder", arguments: request });
    const [sdkReceipt, tool, command] = await Promise.all([
      client.rescheduleDailyReminder(request), invoke(),
      cli("reschedule-daily-reminder", "--request-id", request.requestId, "--series-id", request.seriesId, "--version", "1", "--at", "10:00"),
    ]);
    const expected = { requestId: request.requestId, seriesId: target.seriesId, localTime: "10:00",
      timeZone: "Asia/Shanghai", nextAt: Date.parse("2026-11-21T02:00:00Z"), version: 2 };
    expect(sdkReceipt).toEqual(expected);
    expect(tool.isError).not.toBe(true);
    expect(JSON.parse((tool.content as { text: string }[])[0]!.text)).toEqual(expected);
    expect(JSON.parse(command.stdout)).toEqual(expected);
    await expect(client.rescheduleDailyReminder({ ...request, requestId: randomUUID() })).rejects.toThrow(/409/);
    await expect(client.rescheduleDailyReminder({ ...request, seriesId: keep.seriesId })).rejects.toThrow(/409/);
    await pair(rescheduling, "--revoke-reminder-recurring-reschedule");
    expect((await invoke()).isError).toBe(true);
    expect((await creator.listDailyReminders()).reminders).toEqual([
      { seriesId: keep.seriesId, message: "休息", localTime: "09:00", timeZone: "Asia/Shanghai", nextAt: keep.nextAt },
      { seriesId: target.seriesId, message: "休息", localTime: "10:00", timeZone: "Asia/Shanghai", nextAt: expected.nextAt },
    ]);
  } finally {
    try { await host.close(); } finally {
      await runtime.stop();
      clock.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 30_000);
