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

it("跨入口只改一次，同一授权可改每日和工作日但回执、目标不能串用", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maneki-weekday-reschedule-"));
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-20T00:55:00Z"));
  const runtime = await startRuntime({ configDir: directory });
  const baseUrl = `http://127.0.0.1:${runtime.port}`;
  const host = new Client({ name: "weekday-reschedule-fixture", version: "1" });
  const pair = async (capability: string, flag: string, name = "host") => (await run(process.execPath,
    [join(scripts, `pair-${capability}-client.mjs`), directory, String(runtime.port), name, flag],
    { windowsHide: true, timeout: 8000 })).stdout.trim();
  try {
    runtime.store.assistantStore().set("settings", JSON.stringify({ ...defaultAssistantSettings(), timeZone: "Asia/Shanghai" }));
    const recurring = "reminder-recurring";
    const moving = "reminder-recurring-reschedule";
    const creatorFile = await pair(recurring, "--allow-reminder-recurring");
    const rescheduleFile = await pair(moving, "--allow-reminder-recurring-reschedule");
    const creator = createRecurringReminderClient({ baseUrl, tokenFile: creatorFile });
    const mover = createRecurringReminderRescheduleClient({ baseUrl, tokenFile: rescheduleFile });
    const other = createRecurringReminderClient({ baseUrl, tokenFile: await pair(recurring, "--allow-reminder-recurring", "other") });
    const admin = await openAdminSession(directory, runtime.port);
    const { token } = JSON.parse(readFileSync(creatorFile, "utf8")) as { token: string };
    expect((await admin.request("/v1/recurring-reminders/weekdays/reschedule/targets", undefined, token)).status).toBe(403);
    const input = () => ({ requestId: randomUUID(), localTime: "09:00", message: "休息" });
    const target = await creator.createWeekdayReminder(input());
    const daily = await creator.createDailyReminder(input());
    const hidden = await other.createWeekdayReminder(input());
    expect((await mover.listTargets()).reminders.map(rule => rule.seriesId)).toEqual([daily.seriesId]);
    const targets = await mover.listWeekdayTargets();
    expect(targets.reminders.map(rule => [rule.seriesId, rule.version])).toEqual([[target.seriesId, 1]]);
    const env = { MANEKI_RUNTIME_URL: baseUrl, MANEKI_REMINDER_RECURRING_RESCHEDULE_TOKEN_FILE: rescheduleFile };
    const cli = (...args: string[]) => run(process.execPath, [join(dist, "main.js"), ...args], { env, timeout: 8000, windowsHide: true });
    expect(JSON.parse((await cli("weekday-reschedule-targets")).stdout)).toEqual(targets);
    await host.connect(new StdioClientTransport({ command: process.execPath, args: [join(dist, "reminder-weekdays-reschedule-mcp.js")], env }));
    expect((await host.listTools()).tools.map(tool => tool.name).sort()).toEqual(
      ["maneki_list_weekday_reschedule_targets", "maneki_reschedule_weekday_reminder"],
    );
    const toolTargets = await host.callTool({ name: "maneki_list_weekday_reschedule_targets", arguments: {} });
    expect(toolTargets.isError).not.toBe(true);
    expect(JSON.parse((toolTargets.content as { text: string }[])[0]!.text)).toEqual(targets);
    expect((await host.callTool({ name: "maneki_list_weekday_reschedule_targets", arguments: { version: 1 } })).isError).toBe(true);
    expect((await host.callTool({ name: "maneki_list_daily_reschedule_targets", arguments: {} })).isError).toBe(true);
    const request = { requestId: randomUUID(), seriesId: target.seriesId, version: 1, localTime: "10:00" };
    await expect(mover.rescheduleWeekdayReminder({ ...request, seriesId: hidden.seriesId })).rejects.toThrow(/404/);
    const call = () => host.callTool({ name: "maneki_reschedule_weekday_reminder", arguments: request });
    const [sdk, mcp, command] = await Promise.all([mover.rescheduleWeekdayReminder(request), call(),
      cli("reschedule-weekday-reminder", "--request-id", request.requestId, "--series-id", request.seriesId, "--version", "1", "--at", "10:00"),
    ]);
    const receipt = { ...request, version: 2, timeZone: "Asia/Shanghai", nextAt: Date.parse("2026-11-20T02:00:00Z") };
    expect(sdk).toEqual(receipt);
    expect(mcp.isError).not.toBe(true);
    expect(JSON.parse((mcp.content as { text: string }[])[0]!.text)).toEqual(receipt);
    expect(JSON.parse(command.stdout)).toEqual(receipt);
    await expect(mover.rescheduleDailyReminder({ ...request, seriesId: daily.seriesId })).rejects.toThrow(/409/);
    await expect(mover.rescheduleWeekdayReminder({ ...request, requestId: randomUUID() })).rejects.toThrow(/409/);
    await pair(moving, "--revoke-reminder-recurring-reschedule");
    expect((await call()).isError).toBe(true);
    expect((await creator.listWeekdayReminders()).reminders).toEqual([
      { seriesId: target.seriesId, message: "休息", localTime: "10:00", timeZone: "Asia/Shanghai", nextAt: receipt.nextAt },
    ]);
    expect((await creator.listDailyReminders()).reminders[0]?.nextAt).toBe(daily.nextAt);
  } finally {
    try { await host.close(); } finally {
      await runtime.stop();
      clock.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 30_000);
