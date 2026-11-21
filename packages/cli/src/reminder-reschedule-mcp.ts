#!/usr/bin/env node
import {
  AGENT_REMINDER_ID_PATTERN, AGENT_REMINDER_UUID_PATTERN, MAX_AGENT_REMINDER_DELAY_SECONDS,
  normalizeAgentReminderRescheduleInput,
} from "@maneki-pet/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { reminderRescheduleClient, safeReminderError } from "./reminder-command.js";

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    process.stderr.write("通过 MANEKI_RUNTIME_URL 和 MANEKI_REMINDER_RESCHEDULE_TOKEN_FILE 配置提醒改期桥\n");
    process.exitCode = 2;
    return;
  }
  const client = reminderRescheduleClient();
  const server = new Server({ name: "maneki-reminder-reschedule", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{
      name: "maneki_reschedule_reminder",
      description: "仅当用户明确要求改期一条提醒时调用。先查询列表。遇到「刚才那个」时，用上轮创建回执的 ID 与列表核对。仍无法唯一定位时，请用户选定。传入完整小写提醒 ID、查询所得版本，以及从改期受理时刻起算的延时秒数。每条新意图生成独立 requestId，结果未知时使用原 requestId、提醒 ID、版本和延时重试。版本冲突时重新查询并请用户确认。",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", pattern: AGENT_REMINDER_ID_PATTERN.source },
          reminderId: { type: "string", pattern: AGENT_REMINDER_UUID_PATTERN.source },
          version: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          afterSeconds: { type: "integer", minimum: 1, maximum: MAX_AGENT_REMINDER_DELAY_SECONDS },
        },
        required: ["requestId", "reminderId", "version", "afterSeconds"], additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    const input = normalizeAgentReminderRescheduleInput(params.arguments);
    if (params.name !== "maneki_reschedule_reminder" || !input) {
      return { isError: true, content: [{ type: "text", text: "未知工具或无效提醒改期参数" }] };
    }
    try {
      const receipt = await client.rescheduleReminder(input, signal);
      return { content: [{ type: "text", text: JSON.stringify(receipt) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: safeReminderError(error) }] };
    }
  });
  await server.connect(new StdioServerTransport());
}

void main().catch((error: unknown) => {
  process.stderr.write(`${safeReminderError(error)}\n`);
  process.exitCode = 1;
});
