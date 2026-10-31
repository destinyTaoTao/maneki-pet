import { describe, expect, it } from "vitest";

import {
  DailyQuotaPolicy,
  defaultDailyQuotaConfig,
  type QuotaLedger,
} from "../src/index.js";

class MemoryLedger implements QuotaLedger {
  private readonly days = new Map<string, number>();

  totalForDay(dayKey: string): number {
    return this.days.get(dayKey) ?? 0;
  }

  record(dayKey: string, tokens: number): void {
    this.days.set(dayKey, (this.days.get(dayKey) ?? 0) + tokens);
  }
}

function makeClock(): { now: () => Date; advanceDay: () => void } {
  let current = new Date("2026-10-31T10:00:00Z");
  return {
    now: () => current,
    advanceDay: () => {
      current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
    },
  };
}

describe("DailyQuotaPolicy 每日总额限额", () => {
  it("主动调用默认受每日总额约束：到达即停", () => {
    const { now } = makeClock();
    const policy = new DailyQuotaPolicy(
      { ...defaultDailyQuotaConfig, proactiveDailyTokenLimit: 100 },
      new MemoryLedger(),
      now,
    );
    expect(policy.admit("proactive", 60)).toEqual({ allowed: true });
    policy.record(60);
    const decision = policy.admit("proactive", 50);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("60");
      expect(decision.reason).toContain("50");
      expect(decision.reason).toContain("100");
    }
  });

  it("交互调用默认不限额，显式开启后生效", () => {
    const { now } = makeClock();
    const lenient = new DailyQuotaPolicy(defaultDailyQuotaConfig, new MemoryLedger(), now);
    expect(lenient.admit("interactive", 999999)).toEqual({ allowed: true });

    const strict = new DailyQuotaPolicy(
      { ...defaultDailyQuotaConfig, interactiveDailyTokenLimit: 100 },
      new MemoryLedger(),
      now,
    );
    strict.record(30);
    const decision = strict.admit("interactive", 80);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("30");
      expect(decision.reason).toContain("80");
      expect(decision.reason).toContain("100");
    }
  });

  it("额度按日共享：开启交互总额后，换调用类型也不能绕过同一日桶", () => {
    const { now } = makeClock();
    const policy = new DailyQuotaPolicy(
      { proactiveDailyTokenLimit: 100, interactiveDailyTokenLimit: 100 },
      new MemoryLedger(),
      now,
    );
    policy.record(100);
    expect(policy.admit("proactive", 1).allowed).toBe(false);
    expect(policy.admit("interactive", 1).allowed).toBe(false);
  });

  it("每日窗口按注入时钟翻页，隔天恢复", () => {
    const { now, advanceDay } = makeClock();
    const policy = new DailyQuotaPolicy(
      { ...defaultDailyQuotaConfig, proactiveDailyTokenLimit: 100 },
      new MemoryLedger(),
      now,
    );
    policy.record(100);
    expect(policy.admit("proactive", 1).allowed).toBe(false);
    advanceDay();
    expect(policy.admit("proactive", 1)).toEqual({ allowed: true });
  });

  it("计量失效立即停止所有调用", () => {
    const { now } = makeClock();
    const policy = new DailyQuotaPolicy(defaultDailyQuotaConfig, new MemoryLedger(), now);
    policy.markMeteringUnhealthy("meter backend unreachable");
    const decision = policy.admit("interactive", 1);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("metering");
    }
    expect(policy.admit("proactive", 1).allowed).toBe(false);
  });

  it("出厂默认：主动调用有保守总额，交互总额默认关闭", () => {
    expect(defaultDailyQuotaConfig.proactiveDailyTokenLimit).toBeGreaterThan(0);
    expect(defaultDailyQuotaConfig.interactiveDailyTokenLimit).toBeNull();
  });
});
