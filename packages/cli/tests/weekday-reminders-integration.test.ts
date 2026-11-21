import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRecurringReminderClient } from "@maneki-pet/sdk";
import { expect, it, vi } from "vitest";
import { openAdminSession } from "../../runtime/dist/admin-session.js";
import { defaultAssistantSettings } from "../../runtime/dist/assistant-settings.js";
import { startRuntime } from "../../runtime/dist/runtime.js";

const run = promisify(execFile);
const scripts = join(import.meta.dirname, "../../runtime/scripts");
const dist = join(import.meta.dirname, "../dist");

it("工作日规则沿用每日授权，跨入口重试，撤销后管理员可取消", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maneki-weekday-reminders-"));
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-20T01:05:00Z"));
  const runtime = await startRuntime({ configDir: directory });
  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const host = new Client({ name: "weekday-reminder-fixture", version: "1" });
  const script = (name: string, ...args: string[]) => run(process.execPath,
    [join(scripts, name), directory, String(runtime.port), "host", ...args], { windowsHide: true, timeout: 8000 });
  const pair = (flag: string) => script("pair-reminder-recurring-client.mjs", flag);
  try {
    const admin = await openAdminSession(directory, runtime.port);
    runtime.store.assistantStore().set("settings", JSON.stringify({ ...defaultAssistantSettings(), timeZone: "Asia/Shanghai" }));
    const rootOnly = await admin.request("/v1/recurring-reminders/weekdays");
    expect(rootOnly.status).toBe(403);
    const oneShot = await admin.request("/v1/pair", { name: "host", scopes: "reminder_create" });
    expect((await admin.request("/v1/recurring-reminders/weekdays", undefined, oneShot.body.token as string)).status).toBe(403);
    const tokenFile = (await pair("--allow-reminder-recurring")).stdout.trim();
    const { token } = JSON.parse(readFileSync(tokenFile, "utf8")) as { token: string };
    expect((await admin.request("/v1/admin/recurring-reminders/weekdays/list", { name: "host" }, token)).status).toBe(403);
    const client = createRecurringReminderClient({ baseUrl, tokenFile });
    const env = { MANEKI_RUNTIME_URL: baseUrl, MANEKI_REMINDER_RECURRING_TOKEN_FILE: tokenFile };
    const cli = (...args: string[]) => run(process.execPath, [join(dist, "main.js"), ...args], { env, timeout: 8000, windowsHide: true });
    await host.connect(new StdioClientTransport({ command: process.execPath, args: [join(dist, "reminder-weekdays-mcp.js")], env }));
    expect((await host.listTools()).tools.map(tool => tool.name).sort()).toEqual(
      ["maneki_cancel_weekday_reminder", "maneki_list_weekday_reminders", "maneki_remind_weekdays"],
    );
    const request = { requestId: randomUUID(), localTime: "09:00", message: "休息" };
    const [receipt, tool, command] = await Promise.all([
      client.createWeekdayReminder(request),
      host.callTool({ name: "maneki_remind_weekdays", arguments: request }),
      cli("remind-weekdays", "--request-id", request.requestId, "--at", "09:00", "--message", "休息"),
    ]);
    expect(tool.isError).not.toBe(true);
    expect(JSON.parse((tool.content as { text: string }[])[0]!.text)).toEqual(receipt);
    expect(JSON.parse(command.stdout)).toEqual(receipt);
    expect(receipt).toMatchObject({ requestId: request.requestId, localTime: "09:00", timeZone: "Asia/Shanghai",
      nextAt: Date.parse("2026-11-23T01:00:00Z") });
    await expect(client.createDailyReminder(request)).rejects.toThrow(/409/);
    const daily = await client.createDailyReminder({ ...request, requestId: randomUUID() });
    expect(daily.nextAt).toBe(Date.parse("2026-11-21T01:00:00Z"));
    const weekdays = await client.listWeekdayReminders();
    expect(weekdays.reminders.map(rule => rule.seriesId)).toEqual([receipt.seriesId]);
    expect((await client.listDailyReminders()).reminders.map(rule => rule.seriesId)).toEqual([daily.seriesId]);
    expect(JSON.parse((await cli("weekday-reminders")).stdout)).toEqual(weekdays);
    const toolList = await host.callTool({ name: "maneki_list_weekday_reminders", arguments: {} });
    expect(toolList.isError).not.toBe(true);
    expect(JSON.parse((toolList.content as { text: string }[])[0]!.text)).toEqual(weekdays);
    await expect(client.cancelWeekdayReminder({ requestId: randomUUID(), seriesId: daily.seriesId })).rejects.toThrow(/404/);
    const cancel = { requestId: randomUUID(), seriesId: receipt.seriesId };
    const expectedCancel = { ...cancel, cancelled: true };
    const [sdkCancel, toolCancel, cliCancel] = await Promise.all([
      client.cancelWeekdayReminder(cancel), host.callTool({ name: "maneki_cancel_weekday_reminder", arguments: cancel }),
      cli("cancel-weekday-reminder", "--request-id", cancel.requestId, "--series-id", cancel.seriesId),
    ]);
    expect(sdkCancel).toEqual(expectedCancel);
    expect(toolCancel.isError).not.toBe(true);
    expect(JSON.parse((toolCancel.content as { text: string }[])[0]!.text)).toEqual(expectedCancel);
    expect(JSON.parse(cliCancel.stdout)).toEqual(expectedCancel);
    expect(await client.createWeekdayReminder(request)).toEqual(receipt);
    expect((await client.listWeekdayReminders()).reminders).toEqual([]);
    const managed = await client.createWeekdayReminder({ ...request, requestId: randomUUID() });
    await pair("--revoke-reminder-recurring");
    await expect(client.listWeekdayReminders()).rejects.toThrow();
    const { reminders } = JSON.parse((await script("manage-daily-reminders.mjs", "list-weekdays")).stdout);
    expect(reminders.map((item: { seriesId: string }) => item.seriesId)).toEqual([managed.seriesId]);
    const manageArgs = ["cancel-weekday", managed.seriesId, "cancel-weekday-from-owner"];
    const managedCancel = JSON.parse((await script("manage-daily-reminders.mjs", ...manageArgs)).stdout);
    expect(managedCancel).toEqual({ requestId: manageArgs[2], seriesId: managed.seriesId, cancelled: true });
    expect(JSON.parse((await script("manage-daily-reminders.mjs", ...manageArgs)).stdout)).toEqual(managedCancel);
    expect(JSON.parse((await script("manage-daily-reminders.mjs", "list-weekdays")).stdout)).toEqual({ reminders: [] });
  } finally {
    try { await host.close(); } finally {
      await runtime.stop();
      clock.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 30_000);
