import { describe, expect, it } from "vitest";

import {
  ConversationContextAssembler,
  type ChatMessage,
  type ContextBudgetConfig,
  type Summarizer,
  type UsageEstimator,
} from "../src/index.js";

const perCharEstimator: UsageEstimator = { estimateTokens: (text) => text.length };

const history: ChatMessage[] = [
  { role: "user", text: "a".repeat(20) },
  { role: "assistant", text: "b".repeat(20) },
  { role: "user", text: "c".repeat(10) },
];

const incoming: ChatMessage[] = [{ role: "user", text: "dd" }];

const fixedSummarizer: Summarizer = {
  summarize: async () => "ab",
};

const config: ContextBudgetConfig = { maxTokens: 40, strategy: "summarize" };

describe("ConversationContextAssembler 会话上下文预算", () => {
  it("预算内原样通过，主/子会话共用同一规则", async () => {
    const assembler = new ConversationContextAssembler({
      estimator: perCharEstimator,
      summarizer: fixedSummarizer,
      config,
    });
    const small = [{ role: "user", text: "hello" } as ChatMessage];
    for (const kind of ["main", "sub"] as const) {
      const result = await assembler.assemble(kind, small, incoming);
      expect(result).toEqual({
        outcome: "assembled",
        assembly: { messages: [...small, ...incoming] },
      });
    }
  });

  it("truncate 策略：丢弃最旧历史直到放行，incoming 始终保留", async () => {
    const assembler = new ConversationContextAssembler({
      estimator: perCharEstimator,
      config: { maxTokens: 40, strategy: "truncate" },
    });
    const result = await assembler.assemble("main", history, incoming);
    expect(result.outcome).toBe("assembled");
    if (result.outcome === "assembled") {
      expect(result.assembly.messages.map((message) => message.text)).toEqual([
        "b".repeat(20),
        "c".repeat(10),
        "dd",
      ]);
      expect(result.assembly.notice).toBeDefined();
    }
  });

  it("truncate 策略：incoming 独自超限直接拒绝", async () => {
    const assembler = new ConversationContextAssembler({
      estimator: perCharEstimator,
      config: { maxTokens: 40, strategy: "truncate" },
    });
    const result = await assembler.assemble("main", [], [{ role: "user", text: "x".repeat(41) }]);
    expect(result.outcome).toBe("rejected");
  });

  it("reject 策略：超限即拒，原因含数值与策略", async () => {
    const assembler = new ConversationContextAssembler({
      estimator: perCharEstimator,
      config: { maxTokens: 40, strategy: "reject" },
    });
    const result = await assembler.assemble("main", history, incoming);
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toContain("52");
      expect(result.reason).toContain("40");
      expect(result.reason).toContain("reject");
    }
  });

  it("summarize 策略：被丢弃前缀生成摘要消息，总量回到预算内", async () => {
    const assembler = new ConversationContextAssembler({
      estimator: perCharEstimator,
      summarizer: fixedSummarizer,
      config,
    });
    const result = await assembler.assemble("main", history, incoming);
    expect(result.outcome).toBe("assembled");
    if (result.outcome === "assembled") {
      const [summary, ...rest] = result.assembly.messages;
      expect(summary?.role).toBe("system");
      expect(summary?.text).toContain("ab");
      expect(rest.map((message) => message.text)).toEqual(["c".repeat(10), "dd"]);
      const totalTokens = result.assembly.messages.reduce((sum, message) => sum + message.text.length, 0);
      expect(totalTokens).toBeLessThanOrEqual(40);
    }
  });

  it("summarize 策略：无 summarizer 时诚实拒绝", async () => {
    const assembler = new ConversationContextAssembler({ estimator: perCharEstimator, config });
    const result = await assembler.assemble("main", history, incoming);
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toContain("summarizer");
    }
  });

  it("summarize 策略：summarizer 失败时同样拒绝而非静默截断", async () => {
    const failing: Summarizer = { summarize: async () => { throw new Error("provider down"); } };
    const assembler = new ConversationContextAssembler({
      estimator: perCharEstimator,
      summarizer: failing,
      config,
    });
    const result = await assembler.assemble("sub", history, incoming);
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toContain("summarizer");
    }
  });
});
