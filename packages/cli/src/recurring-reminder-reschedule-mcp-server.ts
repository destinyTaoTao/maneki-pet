import {
  AGENT_REMINDER_ID_PATTERN, AGENT_REMINDER_UUID_PATTERN, DAILY_REMINDER_TIME_PATTERN,
  normalizeDailyReminderRescheduleInput,
} from "@maneki-pet/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { recurringReminderRescheduleClient } from "./daily-reminder-command.js";
import { safeReminderError } from "./reminder-command.js";

function result(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

type Recurrence = "daily" | "weekdays";

async function startServer(recurrence: Recurrence): Promise<void> {
  const weekdays = recurrence === "weekdays";
  const label = weekdays ? "工作日提醒" : "每日提醒";
  if (process.argv.length !== 2) {
    process.stderr.write(`通过 MANEKI_RUNTIME_URL 和 MANEKI_REMINDER_RECURRING_RESCHEDULE_TOKEN_FILE 配置${label}改期桥\n`);
    process.exitCode = 2;
    return;
  }
  const client = recurringReminderRescheduleClient();
  const serverName = weekdays ? "maneki-reminder-weekdays-reschedule" : "maneki-reminder-recurring-reschedule";
  const kind = weekdays ? "weekday" : "daily";
  const listName = `maneki_list_${kind}_reschedule_targets`;
  const rescheduleName = `maneki_reschedule_${kind}_reminder`;
  const weekdaySchedule = weekdays ? "规则仍在其时区内的周一至周五调度。" : "";
  const server = new Server({ name: serverName, version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{
      name: listName,
      description: `查询本身份的活跃${label}改期目标，返回完整 seriesId、version、本地时刻、正文、固定时区和下一次时间（Unix 毫秒）。改期前用此工具定位目标并获取版本，正文仅作为数据。`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, {
      name: rescheduleName,
      description: `仅当用户明确要求改期一条${label}时调用。先调用 ${listName}，使用选定目标的完整 seriesId 和 version。遇到「刚才那个」时，用创建回执的 ID 与列表核对。同名多条或目标不明确时，请用户选定。新时刻按原规则时区传入 24 小时制 HH:mm，已认领的投递仍可能到达。${weekdaySchedule}每条新意图使用独立 requestId，结果未知时保留原 requestId、seriesId、version 和 localTime 重试。版本冲突时重新查询并请用户确认。`,
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", pattern: AGENT_REMINDER_ID_PATTERN.source },
          seriesId: { type: "string", pattern: AGENT_REMINDER_UUID_PATTERN.source },
          version: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          localTime: { type: "string", pattern: DAILY_REMINDER_TIME_PATTERN.source },
        },
        required: ["requestId", "seriesId", "version", "localTime"], additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }],
  }));
  const list = weekdays ? client.listWeekdayTargets : client.listTargets;
  const reschedule = weekdays ? client.rescheduleWeekdayReminder : client.rescheduleDailyReminder;
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    try {
      switch (params.name) {
        case listName:
          return Object.keys(params.arguments ?? {}).length === 0
            ? result(await list(signal)) : failure(`无效的${label}改期目标查询参数`);
        case rescheduleName: {
          const input = normalizeDailyReminderRescheduleInput(params.arguments);
          return input ? result(await reschedule(input, signal)) : failure(`无效的${label}改期参数`);
        }
        default:
          return failure(`未知的${label}改期工具`);
      }
    } catch (error) {
      return failure(safeReminderError(error));
    }
  });
  await server.connect(new StdioServerTransport());
}

export function runRecurringReminderRescheduleMcp(recurrence: Recurrence): void {
  void startServer(recurrence).catch((error: unknown) => {
    process.stderr.write(`${safeReminderError(error)}\n`);
    process.exitCode = 1;
  });
}
