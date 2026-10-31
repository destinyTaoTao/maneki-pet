import { describe, expect, it } from "vitest";

import {
  ChatCallBudget,
  LatestResultGate,
  defaultSingleCallLimit,
  type CallContext,
  type ChatMessage,
  type ChatProvider,
} from "../src/index.js";

/** 测试用估算器：1 字符 = 1 token，算术直白。 */
const perCharEstimator = { estimateTokens: (text: string) => text.length };

const callContext: CallContext = {
  requestId: "req-1",
  signal: new AbortController().signal,
  deadlineAtMs: Number.MAX_SAFE_INTEGER,
};

const smallMessages: ChatMessage[] = [
  { role: "system", text: "be nice" },
  { role: "user", text: "hello" },
];

const overLimitMessages: ChatMessage[] = [
  { role: "user", text: "x".repeat(30) },
];

class FakeChatProvider implements ChatProvider {
  readonly info = { id: "fake", apiVersion: 1 as const, locality: "local" as const };

  async reply(input: { messages: ChatMessage[] }, ctx: CallContext) {
    if (ctx.signal.aborted) {
      throw new Error("call aborted");
    }
    return { text: input.messages.map((message) => message.text).join("|") };
  }
}

describe("ChatProvider 端口", () => {
  it("可注入假实现，调用携带 CallContext（requestId/取消/deadline）", async () => {
    const provider = new FakeChatProvider();
    await expect(provider.reply({ messages: smallMessages }, callContext)).resolves.toEqual({
      text: "be nice|hello",
    });
  });
});

describe("ChatCallBudget 单次调用限额", () => {
  const defaultLimits = {
    default: { maxInputTokens: 20, maxOutputTokens: 6 },
    byProvider: {} as Record<string, { maxInputTokens: number; maxOutputTokens: number }>,
  };

  it("预算内输入允许通过，交互与主动调用同等受限", () => {
    const budget = new ChatCallBudget(perCharEstimator, defaultLimits);
    expect(budget.admitInput("fake", "interactive", smallMessages)).toEqual({ allowed: true });
    expect(budget.admitInput("fake", "proactive", smallMessages)).toEqual({ allowed: true });
  });

  it("超限输入被阻止，原因包含方向与数值", () => {
    const budget = new ChatCallBudget(perCharEstimator, defaultLimits);
    const decision = budget.admitInput("fake", "interactive", overLimitMessages);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("input");
      expect(decision.reason).toContain("30");
      expect(decision.reason).toContain("20");
    }
  });

  it("按 Provider 覆盖上限：放宽后放行、收紧后拦截", () => {
    const budget = new ChatCallBudget(perCharEstimator, {
      default: { maxInputTokens: 20, maxOutputTokens: 6 },
      byProvider: {
        wideLocal: { maxInputTokens: 50, maxOutputTokens: 6 },
        strictCloud: { maxInputTokens: 5, maxOutputTokens: 6 },
      },
    });
    expect(budget.admitInput("wideLocal", "interactive", overLimitMessages)).toEqual({ allowed: true });
    const strict = budget.admitInput("strictCloud", "interactive", smallMessages);
    expect(strict.allowed).toBe(false);
  });

  it("输出超限被阻止，原因包含方向与数值", () => {
    const budget = new ChatCallBudget(perCharEstimator, defaultLimits);
    const decision = budget.admitOutput("fake", "interactive", "y".repeat(7));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("output");
      expect(decision.reason).toContain("7");
      expect(decision.reason).toContain("6");
    }
  });

  it("输出预算内放行", () => {
    const budget = new ChatCallBudget(perCharEstimator, defaultLimits);
    expect(budget.admitOutput("fake", "proactive", "ok")).toEqual({ allowed: true });
  });

  it("出厂默认限额保持保守值", () => {
    expect(defaultSingleCallLimit.maxInputTokens).toBeGreaterThan(0);
    expect(defaultSingleCallLimit.maxInputTokens).toBeLessThanOrEqual(8192);
    expect(defaultSingleCallLimit.maxOutputTokens).toBeGreaterThan(0);
    expect(defaultSingleCallLimit.maxOutputTokens).toBeLessThanOrEqual(defaultSingleCallLimit.maxInputTokens);
  });
});

describe("LatestResultGate 迟到结果", () => {
  it("最新请求的结果正常返回", async () => {
    const gate = new LatestResultGate<string>();
    await expect(gate.submit("a", Promise.resolve("first"))).resolves.toBe("first");
  });

  it("被更新请求的迟到结果被丢弃，不覆盖新结果", async () => {
    const gate = new LatestResultGate<string>();
    let resolveSlow: (value: string) => void = () => undefined;
    const slow = new Promise<string>((resolve) => {
      resolveSlow = resolve;
    });
    const slowResult = gate.submit("slow", slow);
    const fastResult = gate.submit("fast", Promise.resolve("new"));
    resolveSlow("stale");
    await expect(fastResult).resolves.toBe("new");
    await expect(slowResult).resolves.toBeUndefined();
  });

  it("被更新请求的迟到失败同样被丢弃", async () => {
    const gate = new LatestResultGate<string>();
    let rejectSlow: (error: Error) => void = () => undefined;
    const slow = new Promise<string>((_, reject) => {
      rejectSlow = reject;
    });
    const slowResult = gate.submit("slow", slow);
    const fastResult = gate.submit("fast", Promise.resolve("new"));
    rejectSlow(new Error("stale failure"));
    await expect(fastResult).resolves.toBe("new");
    await expect(slowResult).resolves.toBeUndefined();
  });
});
