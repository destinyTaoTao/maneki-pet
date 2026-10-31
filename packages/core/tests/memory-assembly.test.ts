import { describe, expect, it } from "vitest";

import {
  ConversationContextAssembler,
  MemoryAwareContextAssembler,
  MemoryContextService,
  defaultContextBudgetConfig,
  type CallContext,
  type ChatMessage,
  type ExternalMemoryProvider,
  type MemoryItem,
  type UsageEstimator,
} from "../src/index.js";

const providerInfo = { id: "user-memory", apiVersion: 1 as const, locality: "local" as const };

const callContext: CallContext = {
  requestId: "req-1",
  signal: new AbortController().signal,
  deadlineAtMs: Number.MAX_SAFE_INTEGER,
};

const memoryItems: MemoryItem[] = [
  { id: "m1", text: "用户偏好简洁回复", source: "explicit" },
];

const history: ChatMessage[] = [{ role: "user", text: "hello" }];
const incoming: ChatMessage[] = [{ role: "user", text: "world" }];

const perCharEstimator: UsageEstimator = { estimateTokens: (text) => text.length };

function makeAssembler(provider?: ExternalMemoryProvider): MemoryAwareContextAssembler {
  const memory = provider ? new MemoryContextService({ provider }) : new MemoryContextService();
  return new MemoryAwareContextAssembler({
    assembler: new ConversationContextAssembler({
      estimator: perCharEstimator,
      config: defaultContextBudgetConfig,
    }),
    memory,
  });
}

describe("MemoryAwareContextAssembler 检索注入 × 上下文组装", () => {
  it("记忆命中时作为数据前缀注入，再按预算组装", async () => {
    const provider: ExternalMemoryProvider = {
      info: providerInfo,
      retrieve: async () => ({ items: memoryItems }),
      write: async () => undefined,
    };
    const result = await makeAssembler(provider).assemble({
      sessionKind: "main",
      history,
      incoming,
      query: { text: "偏好" },
      ctx: callContext,
    });
    expect(result.outcome).toBe("assembled");
    if (result.outcome === "assembled") {
      const texts = result.assembly.messages.map((message) => message.text);
      expect(texts[0]).toContain("[background memory]");
      expect(texts[0]).toContain("用户偏好简洁回复");
      expect(texts).toContain("hello");
      expect(texts).toContain("world");
    }
  });

  it("外挂记忆故障降级：组装照常成功，无记忆前缀", async () => {
    const provider: ExternalMemoryProvider = {
      info: providerInfo,
      retrieve: async () => {
        throw new Error("memory backend down");
      },
      write: async () => undefined,
    };
    const result = await makeAssembler(provider).assemble({
      sessionKind: "main",
      history,
      incoming,
      query: { text: "偏好" },
      ctx: callContext,
    });
    expect(result.outcome).toBe("assembled");
    if (result.outcome === "assembled") {
      expect(result.assembly.messages).toEqual([...history, ...incoming]);
    }
  });

  it("外挂记忆关闭：跳过检索，组装照常", async () => {
    const provider: ExternalMemoryProvider = {
      info: providerInfo,
      retrieve: async () => ({ items: memoryItems }),
      write: async () => undefined,
    };
    const service = new MemoryContextService({
      provider,
      config: {
        readEnabled: false,
        writeEnabled: true,
        explicitMemoryEnabled: true,
        implicitReferenceEnabled: true,
        writebackGranularity: "raw",
      },
    });
    const assembler = new MemoryAwareContextAssembler({
      assembler: new ConversationContextAssembler({
        estimator: perCharEstimator,
        config: defaultContextBudgetConfig,
      }),
      memory: service,
    });
    const result = await assembler.assemble({
      sessionKind: "sub",
      history,
      incoming,
      query: { text: "偏好" },
      ctx: callContext,
    });
    expect(result.outcome).toBe("assembled");
    if (result.outcome === "assembled") {
      expect(result.assembly.messages).toEqual([...history, ...incoming]);
    }
  });
});
