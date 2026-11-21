#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { expressionStates, isExpressionState } from "@maneki-pet/sdk";
import { safeStateError, stateClient } from "./state-command.js";

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    process.stderr.write("通过 MANEKI_RUNTIME_URL 和 MANEKI_TOKEN_FILE 配置状态桥\n");
    process.exitCode = 2;
    return;
  }
  const client = stateClient();
  const server = new Server({ name: "maneki-state", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [{
      name: "maneki_set_state",
      description: "更新本来源的 15 秒表现租约，idle 释放本来源；返回当前聚合状态。",
      inputSchema: {
        type: "object", properties: { state: { type: "string", enum: [...expressionStates] } },
        required: ["state"], additionalProperties: false,
      },
    }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    const args = params.arguments;
    if (params.name !== "maneki_set_state" || !args || Object.keys(args).length !== 1 || !isExpressionState(args.state)) {
      return { isError: true, content: [{ type: "text", text: "未知工具或无效状态参数" }] };
    }
    try {
      const state = await client.setState(args.state, signal);
      return { content: [{ type: "text", text: JSON.stringify({ accepted: true, state }) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: safeStateError(error) }] };
    }
  });
  await server.connect(new StdioServerTransport());
}
void main().catch((error: unknown) => {
  process.stderr.write(`${safeStateError(error)}\n`);
  process.exitCode = 1;
});
