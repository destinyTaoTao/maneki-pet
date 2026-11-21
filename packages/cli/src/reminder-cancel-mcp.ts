#!/usr/bin/env node
import { AGENT_REMINDER_ID_PATTERN, AGENT_REMINDER_UUID_PATTERN, normalizeAgentReminderCancelInput } from "@maneki-pet/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { reminderCancelClient, safeReminderError } from "./reminder-command.js";

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    process.stderr.write("通过 MANEKI_RUNTIME_URL 和 MANEKI_REMINDER_CANCEL_TOKEN_FILE 配置提醒取消桥\n");
    process.exitCode = 2;
    return;
  }
  const client = reminderCancelClient();
  const server = new Server({ name: "maneki-reminder-cancel", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{
      name: "maneki_cancel_reminder",
      description: "仅当用户明确要求取消一条提醒时调用。先用 maneki_list_reminders 查询，目标不唯一时请用户选定。传入所选项的完整小写提醒 ID 和查询所得版本。每条新意图生成独立 requestId，同一意图重试须保留原 requestId、提醒 ID 和版本。",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", pattern: AGENT_REMINDER_ID_PATTERN.source },
          reminderId: { type: "string", pattern: AGENT_REMINDER_UUID_PATTERN.source },
          version: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        },
        required: ["requestId", "reminderId", "version"], additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    const input = normalizeAgentReminderCancelInput(params.arguments);
    if (params.name !== "maneki_cancel_reminder" || !input) {
      return { isError: true, content: [{ type: "text", text: "未知工具或无效提醒取消参数" }] };
    }
    try {
      const receipt = await client.cancelReminder(input, signal);
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
