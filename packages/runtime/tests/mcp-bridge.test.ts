import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { describe, expect, it } from "vitest";

import { McpExpressionBridge, NotificationBudget, type ExpressionSinks } from "../src/index.js";

interface RecordedSinks {
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  sinks: ExpressionSinks;
}

function makeSinks(): RecordedSinks {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    sinks: {
      say: (text, mood) => calls.push({ tool: "say", args: { text, mood } }),
      setState: (state) => calls.push({ tool: "setState", args: { state } }),
      play: (action) => calls.push({ tool: "play", args: { action } }),
      notify: (title, body, urgency) => calls.push({ tool: "notify", args: { title, body, urgency } }),
    },
  };
}

interface BridgeOptions {
  dnd?: boolean;
  channelEnabled?: boolean;
  maxPerHour?: number;
}

async function makeBridge(options: BridgeOptions = {}): Promise<{
  bridge: McpExpressionBridge;
  client: Client;
  recorded: RecordedSinks;
}> {
  const recorded = makeSinks();
  const bridge = new McpExpressionBridge({
    sinks: recorded.sinks,
    dndBlocked: () => options.dnd ?? false,
    channelEnabled: () => options.channelEnabled ?? true,
    notifications: new NotificationBudget(options.maxPerHour ?? 30),
  });
  const client = new Client({ name: "test-harness", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), bridge.listen(serverTransport)]);
  return { bridge, client, recorded };
}

describe("MCP 表达桥工具面", () => {
  it("tools/list 暴露四个表达工具，没有执行/审批/策略工具", async () => {
    const { client } = await makeBridge();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "maneki_notify",
      "maneki_play",
      "maneki_say",
      "maneki_set_state",
    ]);
  });

  it("maneki_say / maneki_set_state / maneki_play 直达表达通道", async () => {
    const { client, recorded } = await makeBridge();
    await client.callTool({ name: "maneki_say", arguments: { text: "你好", mood: "happy" } });
    await client.callTool({ name: "maneki_set_state", arguments: { state: "idle" } });
    await client.callTool({ name: "maneki_play", arguments: { action: "wave" } });
    expect(recorded.calls.map((call) => call.tool)).toEqual(["say", "setState", "play"]);
  });

  it("maneki_set_state 拒绝非法状态", async () => {
    const { client, recorded } = await makeBridge();
    const result = await client.callTool({ name: "maneki_set_state", arguments: { state: "not-a-state" } });
    expect(result.isError).toBe(true);
    expect(recorded.calls).toHaveLength(0);
  });

  it("未知工具报错", async () => {
    const { client } = await makeBridge();
    const result = await client.callTool({ name: "maneki_exec", arguments: { cmd: "rm -rf /" } });
    expect(result.isError).toBe(true);
  });
});

describe("maneki_notify 的确定性防打扰门控", () => {
  it("勿扰期间即便 urgency=high 也被拦截，且不送达", async () => {
    const { client, recorded } = await makeBridge({ dnd: true });
    const result = await client.callTool({
      name: "maneki_notify",
      arguments: { title: "任务完成", body: "README 翻译完成", urgency: "high" },
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(((result.content as Array<{ text: string }>)[0]!).text)).toEqual({
      delivered: false,
      reason: "dnd",
    });
    expect(recorded.calls).toHaveLength(0);
  });

  it("通知通道关闭时拦截", async () => {
    const { client, recorded } = await makeBridge({ channelEnabled: false });
    const result = await client.callTool({
      name: "maneki_notify",
      arguments: { title: "t", body: "b" },
    });
    expect(JSON.parse(((result.content as Array<{ text: string }>)[0]!).text)).toEqual({
      delivered: false,
      reason: "channel-disabled",
    });
    expect(recorded.calls).toHaveLength(0);
  });

  it("小时次数预算到达后拦截后续通知", async () => {
    const { client, recorded } = await makeBridge({ maxPerHour: 1 });
    const first = await client.callTool({ name: "maneki_notify", arguments: { title: "1", body: "1" } });
    const second = await client.callTool({ name: "maneki_notify", arguments: { title: "2", body: "2" } });
    expect(JSON.parse(((first.content as Array<{ text: string }>)[0]!).text)).toEqual({ delivered: true });
    expect(JSON.parse(((second.content as Array<{ text: string }>)[0]!).text)).toMatchObject({
      delivered: false,
      reason: expect.stringContaining("notification budget exceeded"),
    });
    expect(recorded.calls).toHaveLength(1);
  });
});
