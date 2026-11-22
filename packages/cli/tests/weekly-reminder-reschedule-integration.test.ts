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
const weeklyPath = "/v1/recurring-reminders/weekly";
const movePath = weeklyPath + "/reschedule";
const listTool = "maneki_list_weekly_reschedule_targets";
const moveTool = "maneki_reschedule_weekly_reminder";

it("四个入口按同一版本改期一次，保留星期、时区与同时间的其他系列", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maneki-weekly-reschedule-"));
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-23T00:55:00Z"));
  const host = new Client({ name: "weekly-reschedule-fixture", version: "1" });
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    runtime = await startRuntime({ configDir: directory });
    const { port } = runtime;
    const baseUrl = `http://127.0.0.1:${port}`;
    const settings = runtime.store.assistantStore();
    settings.set("settings", JSON.stringify({ ...defaultAssistantSettings(), timeZone: "Asia/Shanghai" }));
    const pair = async (capability: string, flag: string, name = "host") => (await run(process.execPath,
      [join(scripts, `pair-${capability}-client.mjs`), directory, String(port), name, flag],
      { windowsHide: true, timeout: 8000 })).stdout.trim();
    const recurring = "reminder-recurring";
    const moving = "reminder-recurring-reschedule";
    const creatorFile = await pair(recurring, "--allow-reminder-recurring");
    const moverFile = await pair(moving, "--allow-reminder-recurring-reschedule");
    const creator = createRecurringReminderClient({ baseUrl, tokenFile: creatorFile });
    const mover = createRecurringReminderRescheduleClient({ baseUrl, tokenFile: moverFile });
    const otherFile = await pair(recurring, "--allow-reminder-recurring", "other");
    const other = createRecurringReminderClient({ baseUrl, tokenFile: otherFile });
    const admin = await openAdminSession(directory, port);
    const readToken = (file: string): string => JSON.parse(readFileSync(file, "utf8")).token;
    const creatorToken = readToken(creatorFile);
    const moveToken = readToken(moverFile);
    expect((await admin.request(movePath + "/targets", undefined, creatorToken)).status).toBe(403);
    expect((await admin.request(weeklyPath, undefined, moveToken)).status).toBe(403);

    const input = () => ({ requestId: randomUUID(), localTime: "09:00", message: "休息" });
    const target = await creator.createWeeklyReminder({ ...input(), daysOfWeek: [1, 3, 5] });
    const decoy = await creator.createWeeklyReminder({ ...input(), daysOfWeek: [1, 5] });
    const hidden = await other.createWeeklyReminder({ ...input(), daysOfWeek: [1, 3, 5] });
    const daily = await creator.createDailyReminder(input());
    const weekday = await creator.createWeekdayReminder(input());
    settings.set("settings", JSON.stringify({ ...defaultAssistantSettings(), timeZone: "UTC" }));

    const targets = await mover.listWeeklyTargets();
    expect(targets.reminders).toHaveLength(2);
    expect(targets.reminders).toEqual(expect.arrayContaining([
      expect.objectContaining({ seriesId: target.seriesId, daysOfWeek: [1, 3, 5], timeZone: "Asia/Shanghai", version: 1 }),
      expect.objectContaining({ seriesId: decoy.seriesId, daysOfWeek: [1, 5], timeZone: "Asia/Shanghai", version: 1 }),
    ]));
    expect(await admin.request(movePath + "/targets", undefined, moveToken)).toEqual({ status: 200, body: targets });
    const env = { MANEKI_RUNTIME_URL: baseUrl, MANEKI_REMINDER_RECURRING_RESCHEDULE_TOKEN_FILE: moverFile };
    const cli = (...args: string[]) => run(process.execPath, [join(dist, "main.js"), ...args],
      { env, timeout: 8000, windowsHide: true });
    expect(JSON.parse((await cli("weekly-reschedule-targets")).stdout)).toEqual(targets);
    await host.connect(new StdioClientTransport({
      command: process.execPath, args: [join(dist, "reminder-weekly-reschedule-mcp.js")], env,
    }));
    expect((await host.listTools()).tools.map(tool => tool.name).sort()).toEqual([listTool, moveTool]);
    const toolTargets = await host.callTool({ name: listTool, arguments: {} });
    expect(toolTargets.isError).not.toBe(true);
    expect(JSON.parse((toolTargets.content as { text: string }[])[0]!.text)).toEqual(targets);

    const request = { requestId: randomUUID(), seriesId: target.seriesId, version: 1, localTime: "10:00" };
    const call = () => host.callTool({ name: moveTool, arguments: request });
    expect((await admin.request(movePath, { ...request, daysOfWeek: [2, 2] }, moveToken)).status).toBe(400);
    expect((await admin.request(movePath, request, creatorToken)).status).toBe(403);
    expect((await admin.request(movePath + "/targets", request, moveToken)).status).toBe(403);
    expect((await host.callTool({ name: moveTool, arguments: { ...request, timeZone: "UTC" } })).isError).toBe(true);
    await expect(mover.rescheduleWeeklyReminder({ ...request, seriesId: hidden.seriesId })).rejects.toThrow(/404/);
    const [sdk, mcp, command, api] = await Promise.all([
      mover.rescheduleWeeklyReminder(request),
      call(),
      cli("reschedule-weekly-reminder", "--request-id", request.requestId, "--series-id", request.seriesId, "--version", "1", "--at", "10:00"),
      admin.request(movePath, request, moveToken),
    ]);
    const receipt = { ...request, version: 2, timeZone: "Asia/Shanghai", nextAt: Date.parse("2026-11-23T02:00:00Z"), daysOfWeek: [1, 3, 5] };
    expect(sdk).toEqual(receipt);
    expect(mcp.isError).not.toBe(true);
    expect(JSON.parse((mcp.content as { text: string }[])[0]!.text)).toEqual(receipt);
    expect(JSON.parse(command.stdout)).toEqual(receipt);
    expect(api).toEqual({ status: 200, body: receipt });
    await expect(mover.rescheduleDailyReminder({ ...request, seriesId: daily.seriesId })).rejects.toThrow(/409/);
    await expect(mover.rescheduleWeekdayReminder({ ...request, seriesId: weekday.seriesId })).rejects.toThrow(/409/);
    await expect(mover.rescheduleWeeklyReminder({ ...request, seriesId: decoy.seriesId })).rejects.toThrow(/409/);
    await expect(mover.rescheduleWeeklyReminder({ ...request, requestId: randomUUID(), localTime: "11:00" })).rejects.toThrow(/409/);
    const movedTargets = (await mover.listWeeklyTargets()).reminders;
    expect(movedTargets.map(rule => [rule.seriesId, rule.version, rule.localTime])).toEqual([
      [decoy.seriesId, 1, "09:00"], [target.seriesId, 2, "10:00"],
    ]);

    await pair(moving, "--revoke-reminder-recurring-reschedule");
    expect((await call()).isError).toBe(true);
    expect((await creator.listWeeklyReminders()).reminders).toEqual([
      { seriesId: decoy.seriesId, daysOfWeek: decoy.daysOfWeek, localTime: decoy.localTime,
        message: "休息", timeZone: decoy.timeZone, nextAt: decoy.nextAt },
      { seriesId: target.seriesId, daysOfWeek: target.daysOfWeek, localTime: "10:00",
        message: "休息", timeZone: target.timeZone, nextAt: receipt.nextAt },
    ]);
    expect((await other.listWeeklyReminders()).reminders[0]?.nextAt).toBe(hidden.nextAt);
    expect((await creator.listDailyReminders()).reminders[0]?.nextAt).toBe(daily.nextAt);
    expect((await creator.listWeekdayReminders()).reminders[0]?.nextAt).toBe(weekday.nextAt);
  } finally {
    try { await host.close(); } finally {
      await runtime?.stop();
      clock.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 30_000);
