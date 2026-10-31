import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { petStates } from "@maneki-pet/core";

import type { NotificationBudget } from "./quota.js";
import { validateObject } from "./validate.js";

export interface ExpressionSinks {
  say(text: string, mood?: string): void;
  setState(state: string): void;
  play(actionId: string): void;
  notify(title: string, body: string, urgency: string): void;
}

export interface McpExpressionBridgeDeps {
  sinks: ExpressionSinks;
  dndBlocked: () => boolean;
  channelEnabled: () => boolean;
  notifications: NotificationBudget;
}

interface ToolOutcome extends CallToolResult {}

const TOOL_DEFS = [
  {
    name: "maneki_say",
    description: "让桌宠以气泡与已启用的 TTS 说话（表达通道，不执行任务）",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: { type: "string", maxLength: 2000 },
        mood: { type: "string", maxLength: 50 },
      },
      required: ["text"],
    },
  },
  {
    name: "maneki_set_state",
    description: `当前来源的展示状态意图，受仲裁限制；可选值：${petStates.join(", ")}`,
    inputSchema: {
      type: "object" as const,
      properties: { state: { type: "string", enum: [...petStates] } },
      required: ["state"],
    },
  },
  {
    name: "maneki_play",
    description: "播放已安装动作包中的动作 ID",
    inputSchema: {
      type: "object" as const,
      properties: { action: { type: "string", maxLength: 100 } },
      required: ["action"],
    },
  },
  {
    name: "maneki_notify",
    description: "发送受勿扰与限额控制的通知；urgency 不能绕过勿扰",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: { type: "string", maxLength: 200 },
        body: { type: "string", maxLength: 2000 },
        urgency: { type: "string", enum: ["normal", "high"] },
      },
      required: ["title", "body"],
    },
  },
];

/**
 * stdio MCP 表达桥（architecture §5.5）：只暴露表达与通知，
 * 不提供执行/审批/策略修改工具；stdout 仅协议消息。
 * maneki_notify 受确定性防打扰规则约束：勿扰、通道开关、次数预算。
 */
export class McpExpressionBridge {
  private readonly server: Server;

  constructor(private readonly deps: McpExpressionBridgeDeps) {
    this.server = new Server({ name: "maneki-express", version: "0.1.0" }, { capabilities: { tools: {} } });
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.call(request.params.name, request.params.arguments ?? {}),
    );
  }

  async connectStdio(): Promise<void> {
    await this.server.connect(new StdioServerTransport());
  }

  /** 测试入口：任意传输（如 InMemoryTransport）。 */
  async listen(transport: Parameters<Server["connect"]>[0]): Promise<void> {
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    await this.server.close();
  }

  private call(name: string, args: Record<string, unknown>): ToolOutcome {
    switch (name) {
      case "maneki_say":
        return this.gated(this.deps.sinks.say.bind(this.deps.sinks), validateObject(args, {
          text: { type: "string", required: true, maxLength: 2000 },
          mood: { type: "string", required: false, maxLength: 50 },
        }), (value) => [value.text as string, value.mood as string | undefined]);
      case "maneki_set_state":
        return this.gated(this.deps.sinks.setState.bind(this.deps.sinks), validateObject(args, {
          state: { type: "string", required: true, maxLength: 50, enumValues: petStates },
        }), (value) => [value.state as string]);
      case "maneki_play":
        return this.gated(this.deps.sinks.play.bind(this.deps.sinks), validateObject(args, {
          action: { type: "string", required: true, maxLength: 100 },
        }), (value) => [value.action as string]);
      case "maneki_notify":
        return this.notify(args);
      default:
        return this.errorOutcome(`unknown tool "${name}"`);
    }
  }

  private gated(
    sink: (...params: never[]) => void,
    validation: ReturnType<typeof validateObject>,
    pick: (value: Record<string, unknown>) => unknown[],
  ): ToolOutcome {
    if (!validation.ok) {
      return this.errorOutcome(validation.reason);
    }
    (sink as (...params: unknown[]) => void)(...pick(validation.value));
    return { content: [{ type: "text", text: JSON.stringify({ delivered: true }) }] };
  }

  private notify(args: Record<string, unknown>): ToolOutcome {
    const checked = validateObject(args, {
      title: { type: "string", required: true, maxLength: 200 },
      body: { type: "string", required: true, maxLength: 2000 },
      urgency: { type: "string", required: false, maxLength: 10, enumValues: ["normal", "high"], default: "normal" },
    });
    if (!checked.ok) {
      return this.errorOutcome(checked.reason);
    }
    // 外部 urgency 不能绕过勿扰（红线）；通道关闭与次数预算同理按确定性规则拦截。
    if (this.deps.dndBlocked()) {
      return this.delivered(false, "dnd");
    }
    if (!this.deps.channelEnabled()) {
      return this.delivered(false, "channel-disabled");
    }
    const budget = this.deps.notifications.canSend(Date.now());
    if (!budget.allowed) {
      return this.delivered(false, budget.reason);
    }
    this.deps.sinks.notify(checked.value.title as string, checked.value.body as string, checked.value.urgency as string);
    this.deps.notifications.record(Date.now());
    return this.delivered(true);
  }

  private delivered(delivered: boolean, reason?: string): ToolOutcome {
    const payload: Record<string, unknown> = { delivered };
    if (reason !== undefined) {
      payload.reason = reason;
    }
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  }

  private errorOutcome(reason: string): ToolOutcome {
    return { content: [{ type: "text", text: JSON.stringify({ error: reason }) }], isError: true };
  }
}

export { StdioServerTransport };
