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
const movePath = "/v1/recurring-reminders/weekly/reschedule";
const moveTool = "maneki_reschedule_weekly_reminder";

it("四个入口用同一请求 ID 更换星期，原时区和时刻固定", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maneki-weekly-change-days-"));
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-24T01:00:00Z"));
  const host = new Client({ name: "weekly-change-days-fixture", version: "1" });
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    runtime = await startRuntime({ configDir: directory });
    const { port } = runtime;
    const baseUrl = `http://127.0.0.1:${port}`;
    const settings = runtime.store.assistantStore();
    settings.set("settings", JSON.stringify({ ...defaultAssistantSettings(), timeZone: "Asia/Shanghai" }));
    const pair = async (capability: string, flag: string) => (await run(process.execPath,
      [join(scripts, `pair-${capability}-client.mjs`), directory, String(port), "host", flag],
      { windowsHide: true, timeout: 8000 })).stdout.trim();
    const creatorFile = await pair("reminder-recurring", "--allow-reminder-recurring");
    const capability = "reminder-recurring-reschedule";
    const moverFile = await pair(capability, `--allow-${capability}`);
    const creator = createRecurringReminderClient({ baseUrl, tokenFile: creatorFile });
    const mover = createRecurringReminderRescheduleClient({ baseUrl, tokenFile: moverFile });
    const admin = await openAdminSession(directory, port);
    const token = (file: string): string => JSON.parse(readFileSync(file, "utf8")).token;
    const moveToken = token(moverFile);

    const localTime = "10:00";
    const message = "休息";
    const create = { requestId: randomUUID(), localTime, message, daysOfWeek: [1, 3, 5] };
    const target = await creator.createWeeklyReminder(create);
    const decoy = await creator.createWeeklyReminder({ ...create, requestId: randomUUID(), daysOfWeek: [3, 5] });
    expect(target.nextAt).toBe(Date.parse("2026-11-25T02:00:00Z"));
    settings.set("settings", JSON.stringify({ ...defaultAssistantSettings(), timeZone: "UTC" }));

    const input = { requestId: randomUUID(), seriesId: target.seriesId, version: 1, localTime, daysOfWeek: [2, 4] };
    expect((await admin.request(movePath, input, token(creatorFile))).status).toBe(403);
    expect((await admin.request("/v1/recurring-reminders/weekdays/reschedule", input, moveToken)).status).toBe(400);
    expect((await admin.request(movePath, { ...input, daysOfWeek: [4, 4] }, moveToken)).status).toBe(400);
    expect((await admin.request(movePath, { ...input, daysOfWeek: [5, 1, 3] }, moveToken)).status).toBe(409);
    expect((await admin.request(movePath, { ...input, timeZone: "UTC" }, moveToken)).status).toBe(400);

    const env = { MANEKI_RUNTIME_URL: baseUrl, MANEKI_REMINDER_RECURRING_RESCHEDULE_TOKEN_FILE: moverFile };
    const cli = (...args: string[]) => run(process.execPath, [join(dist, "main.js"), ...args], { env, timeout: 8000, windowsHide: true });
    await host.connect(new StdioClientTransport({
      command: process.execPath, args: [join(dist, "reminder-weekly-reschedule-mcp.js")], env,
    }));
    const tools = (await host.listTools()).tools;
    expect(tools.find(tool => tool.name === moveTool)?.inputSchema).toMatchObject({
      required: ["requestId", "seriesId", "version", "localTime"],
      properties: { daysOfWeek: { type: "array", uniqueItems: true } },
    });
    expect((await host.callTool({ name: moveTool, arguments: { ...input, daysOfWeek: [] } })).isError).toBe(true);
    const [sdk, mcp, command, api] = await Promise.all([
      mover.rescheduleWeeklyReminder(input),
      host.callTool({ name: moveTool, arguments: { ...input, daysOfWeek: [4, 2] } }),
      cli("reschedule-weekly-reminder", "--request-id", input.requestId, "--series-id", input.seriesId, "--version", "1",
        "--at", localTime, "--days", "2,4"),
      admin.request(movePath, { ...input, daysOfWeek: [4, 2] }, moveToken),
    ]);
    const receipt = { ...input, version: 2, timeZone: "Asia/Shanghai", nextAt: Date.parse("2026-11-24T02:00:00Z") };
    expect(sdk).toEqual(receipt);
    expect(mcp.isError).not.toBe(true);
    expect(JSON.parse((mcp.content as { text: string }[])[0]!.text)).toEqual(receipt);
    expect(JSON.parse(command.stdout)).toEqual(receipt);
    expect(api).toEqual({ status: 200, body: receipt });
    await expect(mover.rescheduleWeeklyReminder({ ...input, daysOfWeek: [2] })).rejects.toThrow(/409/);
    await expect(mover.rescheduleWeeklyReminder({ ...input, requestId: randomUUID() })).rejects.toThrow(/409/);
    expect((await mover.listWeeklyTargets()).reminders).toEqual([
      { seriesId: target.seriesId, localTime, message, daysOfWeek: [2, 4], timeZone: target.timeZone, version: 2, nextAt: receipt.nextAt },
      { seriesId: decoy.seriesId, localTime, message, daysOfWeek: [3, 5], timeZone: decoy.timeZone, version: 1, nextAt: decoy.nextAt },
    ]);

    await pair(capability, `--revoke-${capability}`);
    expect((await host.callTool({ name: moveTool, arguments: input })).isError).toBe(true);
    expect((await creator.listWeeklyReminders()).reminders[0]?.seriesId).toBe(target.seriesId);
  } finally {
    try { await host.close(); } finally {
      await runtime?.stop();
      clock.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 30_000);
