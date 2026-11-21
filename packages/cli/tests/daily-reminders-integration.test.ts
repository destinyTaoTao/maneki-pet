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

it("不同入口重放同一个每日规则，凭证撤销后本机用户仍能停止它", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maneki-daily-reminders-"));
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-21T09:59:00Z"));
  const runtime = await startRuntime({ configDir: directory });
  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const host = new Client({ name: "daily-reminder-fixture", version: "1" });
  const script = (name: string, ...args: string[]) => run(process.execPath,
    [join(scripts, name), directory, String(runtime.port), "host", ...args], { windowsHide: true, timeout: 8000 });
  const pair = (flag: string) => script("pair-reminder-recurring-client.mjs", flag);
  try {
    const admin = await openAdminSession(directory, runtime.port);
    runtime.store.assistantStore().set("settings", JSON.stringify({ ...defaultAssistantSettings(), timeZone: "Asia/Shanghai" }));
    expect((await admin.request("/v1/pair", { name: "mixed", scopes: "reminder_recurring,reminder_create" })).status).toBe(400);
    const single = await admin.request("/v1/pair", { name: "host", scopes: "reminder_create" });
    const singleToken = single.body.token as string;
    expect((await admin.request("/v1/recurring-reminders", undefined, singleToken)).status).toBe(403);
    const tokenFile = (await pair("--allow-reminder-recurring")).stdout.trim();
    expect((await pair("--allow-reminder-recurring")).stdout.trim()).toBe(tokenFile);
    const { token } = JSON.parse(readFileSync(tokenFile, "utf8")) as { token: string };
    expect((await admin.request("/v1/reminders/identity", undefined, token)).status).toBe(403);
    expect((await admin.request("/v1/admin/recurring-reminders/list", { name: "host" }, token)).status).toBe(403);
    const agent = createRecurringReminderClient({ baseUrl, tokenFile });
    const env = { MANEKI_RUNTIME_URL: baseUrl, MANEKI_REMINDER_RECURRING_TOKEN_FILE: tokenFile };
    const cli = (...args: string[]) => run(process.execPath, [join(dist, "main.js"), ...args], { env, timeout: 8000, windowsHide: true });
    await host.connect(new StdioClientTransport({ command: process.execPath, args: [join(dist, "reminder-recurring-mcp.js")], env }));
    expect((await host.listTools()).tools.map(tool => tool.name).sort()).toEqual(
      ["maneki_cancel_daily_reminder", "maneki_list_daily_reminders", "maneki_remind_daily"],
    );
    const request = { requestId: randomUUID(), localTime: "09:00", message: "休息" };
    const [receipt, tool, command] = await Promise.all([
      agent.createDailyReminder(request),
      host.callTool({ name: "maneki_remind_daily", arguments: request }),
      cli("remind-daily", "--request-id", request.requestId, "--at", request.localTime, "--message", request.message),
    ]);
    expect(tool.isError).not.toBe(true);
    expect(JSON.parse((tool.content as { text: string }[])[0]!.text)).toEqual(receipt);
    expect(JSON.parse(command.stdout)).toEqual(receipt);
    expect(receipt).toMatchObject({ requestId: request.requestId, localTime: "09:00", timeZone: "Asia/Shanghai",
      nextAt: Date.parse("2026-11-22T01:00:00Z") });
    const { requestId: _requestId, ...summary } = receipt;
    expect(await agent.listDailyReminders()).toEqual({ reminders: [{ ...summary, message: "休息" }] });
    expect(JSON.parse((await cli("daily-reminders")).stdout)).toEqual(await agent.listDailyReminders());
    await expect(agent.createDailyReminder({ ...request, localTime: "10:00" })).rejects.toThrow(/409/);
    const disposable = { requestId: randomUUID(), localTime: "12:00", message: "喝水" };
    const second = await agent.createDailyReminder(disposable);
    const cancelInput = { requestId: randomUUID(), seriesId: second.seriesId };
    const [cancelledBySdk, cancelledByTool, cancelledByCommand] = await Promise.all([
      agent.cancelDailyReminder(cancelInput),
      host.callTool({ name: "maneki_cancel_daily_reminder", arguments: cancelInput }),
      cli("cancel-daily-reminder", "--request-id", cancelInput.requestId, "--series-id", cancelInput.seriesId),
    ]);
    expect(cancelledBySdk).toEqual({ ...cancelInput, cancelled: true });
    expect(cancelledByTool.isError).not.toBe(true);
    expect(JSON.parse((cancelledByTool.content as { text: string }[])[0]!.text)).toEqual(cancelledBySdk);
    expect(JSON.parse(cancelledByCommand.stdout)).toEqual(cancelledBySdk);
    expect(await agent.createDailyReminder(disposable)).toEqual(second);
    expect((await agent.listDailyReminders()).reminders.map(item => item.seriesId)).toEqual([receipt.seriesId]);
    expect((await admin.request("/v1/recurring-reminders/cancel", { requestId: "cancel-admin", seriesId: receipt.seriesId })).status).toBe(403);
    await pair("--revoke-reminder-recurring");
    await expect(agent.listDailyReminders()).rejects.toThrow();
    expect(JSON.parse((await script("manage-daily-reminders.mjs", "list")).stdout)).toEqual({ reminders: [{ ...summary, message: "休息" }] });
    const cancellation = ["cancel", receipt.seriesId, "cancel-daily-from-owner"];
    const cancelled = JSON.parse((await script("manage-daily-reminders.mjs", ...cancellation)).stdout);
    expect(cancelled).toEqual({ requestId: cancellation[2], seriesId: receipt.seriesId, cancelled: true });
    expect(JSON.parse((await script("manage-daily-reminders.mjs", ...cancellation)).stdout)).toEqual(cancelled);
    expect(JSON.parse((await script("manage-daily-reminders.mjs", "list")).stdout)).toEqual({ reminders: [] });
  } finally {
    try { await host.close(); } finally {
      await runtime.stop();
      clock.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 30_000);
