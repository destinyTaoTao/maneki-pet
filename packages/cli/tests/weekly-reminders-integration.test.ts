import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { get } from "node:http";
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
const weeklyPath = "/v1/recurring-reminders/weekly";
const weeklyAdminPath = "/v1/admin/recurring-reminders/weekly";

it("指定星期共用重复提醒授权，跨入口按星期集合去重并按原系列取消", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maneki-weekly-reminders-"));
  const host = new Client({ name: "weekly-reminder-fixture", version: "1" });
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-24T01:05:00Z"));
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    runtime = await startRuntime({ configDir: directory });
    const { port } = runtime;
    const baseUrl = `http://127.0.0.1:${port}`;
    const script = (name: string, ...args: string[]) => run(process.execPath,
      [join(scripts, name), directory, String(port), "host", ...args], { windowsHide: true, timeout: 8000 });
    const pair = (flag: string) => script("pair-reminder-recurring-client.mjs", flag);
    const admin = await openAdminSession(directory, port);
    runtime.store.assistantStore().set("settings", JSON.stringify({ ...defaultAssistantSettings(), timeZone: "Asia/Shanghai" }));

    const request = { requestId: randomUUID(), localTime: "09:00", message: "休息", daysOfWeek: [1, 3, 5] };
    const registered = await admin.request("/v1/pair", { name: "host", scopes: "reminder_create" });
    expect(registered.status).toBe(200);
    expect((await admin.request(weeklyPath, request)).status).toBe(403);
    expect((await admin.request(weeklyPath, request, registered.body.token as string)).status).toBe(403);

    const tokenFile = (await pair("--allow-reminder-recurring")).stdout.trim();
    const { token } = JSON.parse(readFileSync(tokenFile, "utf8")) as { token: string };
    const reschedule = await admin.request("/v1/pair", { name: "host", scopes: "reminder_recurring_reschedule" });
    expect(reschedule.status).toBe(200);
    expect((await admin.request(weeklyPath, request, reschedule.body.token as string)).status).toBe(403);
    expect((await admin.request(weeklyAdminPath + "/list", { name: "host" }, token)).status).toBe(403);
    expect((await admin.request(weeklyPath, { ...request, daysOfWeek: [1, 1, 5] }, token)).status).toBe(400);
    expect((await admin.request(weeklyPath, { ...request, timeZone: "UTC" }, token)).status).toBe(400);

    const client = createRecurringReminderClient({ baseUrl, tokenFile });
    const env = { MANEKI_RUNTIME_URL: baseUrl, MANEKI_REMINDER_RECURRING_TOKEN_FILE: tokenFile };
    const cli = (...args: string[]) => run(process.execPath, [join(dist, "main.js"), ...args], { env, timeout: 8000, windowsHide: true });
    await host.connect(new StdioClientTransport({ command: process.execPath, args: [join(dist, "reminder-weekly-mcp.js")], env }));
    const { tools } = await host.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(
      ["maneki_cancel_weekly_reminder", "maneki_list_weekly_reminders", "maneki_remind_weekly"],
    );
    expect(tools.find(tool => tool.name === "maneki_remind_weekly")?.inputSchema).toMatchObject({
      required: ["requestId", "localTime", "message", "daysOfWeek"],
      properties: { daysOfWeek: { uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 7 } } },
    });
    expect((await host.callTool({
      name: "maneki_remind_weekly", arguments: { ...request, daysOfWeek: [1, 1, 5] },
    })).isError).toBe(true);
    const [receipt, tool, command, api] = await Promise.all([
      client.createWeeklyReminder(request),
      host.callTool({ name: "maneki_remind_weekly", arguments: { ...request, daysOfWeek: [5, 1, 3] } }),
      cli("remind-weekly", "--request-id", request.requestId, "--days", "1,3,5", "--at", "09:00", "--message", "休息"),
      admin.request(weeklyPath, { ...request, daysOfWeek: [3, 5, 1] }, token),
    ]);
    expect(tool.isError).not.toBe(true);
    expect(JSON.parse((tool.content as { text: string }[])[0]!.text)).toEqual(receipt);
    expect(JSON.parse(command.stdout)).toEqual(receipt);
    expect(api).toEqual({ status: 200, body: receipt });
    expect(receipt).toMatchObject({ requestId: request.requestId, daysOfWeek: [1, 3, 5], localTime: "09:00",
      timeZone: "Asia/Shanghai", nextAt: Date.parse("2026-11-25T01:00:00Z") });
    expect((await admin.request(weeklyPath, { ...request, daysOfWeek: [1, 3] }, token)).status).toBe(409);
    const { daysOfWeek, ...dailyInput } = request;
    await expect(client.createDailyReminder(dailyInput)).rejects.toThrow(/409/);
    const daily = await client.createDailyReminder({ ...dailyInput, requestId: randomUUID() });
    const weekly = await client.listWeeklyReminders();
    expect(weekly.reminders.map(rule => rule.seriesId)).toEqual([receipt.seriesId]);
    expect(weekly.reminders[0]?.daysOfWeek).toEqual(daysOfWeek);
    const cacheControl = await new Promise<string | undefined>((resolve, reject) => {
      get(baseUrl + weeklyPath, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) }, res => {
        res.on("error", reject);
        res.on("end", () => resolve(res.headers["cache-control"]));
        res.resume();
      }).on("error", reject);
    });
    expect(cacheControl).toBe("no-store");
    expect((await client.listDailyReminders()).reminders.map(rule => rule.seriesId)).toEqual([daily.seriesId]);
    expect(JSON.parse((await cli("weekly-reminders")).stdout)).toEqual(weekly);
    const toolList = await host.callTool({ name: "maneki_list_weekly_reminders", arguments: {} });
    expect(toolList.isError).not.toBe(true);
    expect(JSON.parse((toolList.content as { text: string }[])[0]!.text)).toEqual(weekly);

    await expect(client.cancelWeeklyReminder({ requestId: randomUUID(), seriesId: daily.seriesId })).rejects.toThrow(/404/);
    const other = await admin.request("/v1/pair", { name: "other", scopes: "reminder_recurring" });
    expect(other.status).toBe(200);
    const otherToken = other.body.token as string;
    const cancel = { requestId: randomUUID(), seriesId: receipt.seriesId };
    expect(await admin.request(weeklyPath, undefined, otherToken)).toEqual({ status: 200, body: { reminders: [] } });
    expect((await admin.request(weeklyPath + "/cancel", cancel, otherToken)).status).toBe(404);
    const expectedCancel = { ...cancel, cancelled: true };
    const [sdkCancel, toolCancel, cliCancel] = await Promise.all([
      client.cancelWeeklyReminder(cancel), host.callTool({ name: "maneki_cancel_weekly_reminder", arguments: cancel }),
      cli("cancel-weekly-reminder", "--request-id", cancel.requestId, "--series-id", cancel.seriesId),
    ]);
    expect(sdkCancel).toEqual(expectedCancel);
    expect(toolCancel.isError).not.toBe(true);
    expect(JSON.parse((toolCancel.content as { text: string }[])[0]!.text)).toEqual(expectedCancel);
    expect(JSON.parse(cliCancel.stdout)).toEqual(expectedCancel);
    expect((await admin.request(weeklyPath + "/cancel", { ...cancel, seriesId: daily.seriesId }, token)).status).toBe(409);
    expect(await client.createWeeklyReminder(request)).toEqual(receipt);
    expect(await client.listWeeklyReminders()).toEqual({ reminders: [] });

    const managed = await client.createWeeklyReminder({ ...request, requestId: randomUUID() });
    await pair("--revoke-reminder-recurring");
    await expect(client.listWeeklyReminders()).rejects.toThrow();
    const { reminders } = JSON.parse((await script("manage-daily-reminders.mjs", "list-weekly")).stdout);
    expect(reminders.map((item: { seriesId: string }) => item.seriesId)).toEqual([managed.seriesId]);
    const manageArgs = ["cancel-weekly", managed.seriesId, "cancel-weekly-from-owner"];
    const managedCancel = JSON.parse((await script("manage-daily-reminders.mjs", ...manageArgs)).stdout);
    expect(managedCancel).toEqual({ requestId: manageArgs[2], seriesId: managed.seriesId, cancelled: true });
    expect(JSON.parse((await script("manage-daily-reminders.mjs", ...manageArgs)).stdout)).toEqual(managedCancel);
    expect(JSON.parse((await script("manage-daily-reminders.mjs", "list-weekly")).stdout)).toEqual({ reminders: [] });
  } finally {
    try { await host.close(); } finally {
      await runtime?.stop();
      clock.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 30_000);
