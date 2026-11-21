#!/usr/bin/env node
import {
  AGENT_REMINDER_ID_PATTERN, MAX_AGENT_REMINDER_DELAY_SECONDS, MAX_AGENT_REMINDER_MESSAGE_LENGTH, normalizeAgentReminder,
} from "@maneki-pet/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { reminderClient, safeReminderError } from "./reminder-command.js";

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    process.stderr.write("通过 MANEKI_RUNTIME_URL 和 MANEKI_REMINDER_TOKEN_FILE 配置提醒桥\n");
    process.exitCode = 2;
    return;
  }
  const client = reminderClient();
  const server = new Server({ name: "maneki-reminder", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{
      name: "maneki_remind",
      description: "仅当用户明确要求提醒时创建一次提醒。每条新意图生成独立 requestId，同一意图重试时复用原 ID、延时和内容。返回已保存的提醒 ID 和到期时间（Unix 毫秒）。",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", pattern: AGENT_REMINDER_ID_PATTERN.source },
          afterSeconds: { type: "integer", minimum: 1, maximum: MAX_AGENT_REMINDER_DELAY_SECONDS },
          message: { type: "string", minLength: 1, description: `提醒正文，去除首尾空白后为 1 至 ${MAX_AGENT_REMINDER_MESSAGE_LENGTH} 个 UTF-16 码元。` },
        },
        required: ["requestId", "afterSeconds", "message"], additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    const input = normalizeAgentReminder(params.arguments);
    if (params.name !== "maneki_remind" || !input) {
      return { isError: true, content: [{ type: "text", text: "未知工具或无效提醒参数" }] };
    }
    try {
      const receipt = await client.createReminder(input, signal);
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
