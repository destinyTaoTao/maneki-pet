/**
 * 每日总额限额（architecture §4.1 限额三层之三，2026-10-31 决策）：
 * 默认仅约束主动收费调用，交互调用总额显式开启；到达限额即停，
 * 计量失效立即停止所有调用；额度按日共享，更换 Provider 不能绕过。
 */
export type QuotaKind = "interactive" | "proactive";

export interface DailyQuotaConfig {
  proactiveDailyTokenLimit: number;
  /** null 表示交互调用总额关闭（出厂默认）。 */
  interactiveDailyTokenLimit: number | null;
}

export const defaultDailyQuotaConfig: DailyQuotaConfig = {
  proactiveDailyTokenLimit: 100_000,
  interactiveDailyTokenLimit: null,
};

/** 记账存储端口：Core 无 IO，由注入实现持久化（Runtime 用 SQLite）。 */
export interface QuotaLedger {
  totalForDay(dayKey: string): number;
  record(dayKey: string, tokens: number): void;
}

export type QuotaDecision = { allowed: true } | { allowed: false; reason: string };

export class DailyQuotaPolicy {
  private unhealthyReason: string | null = null;

  constructor(
    private readonly config: DailyQuotaConfig = defaultDailyQuotaConfig,
    private readonly ledger: QuotaLedger,
    private readonly clock: () => Date,
  ) {}

  /** 当前记账日（UTC 日界，跨实现一致）。 */
  dayKey(): string {
    return this.clock().toISOString().slice(0, 10);
  }

  admit(kind: QuotaKind, estimatedTokens: number): QuotaDecision {
    if (this.unhealthyReason !== null) {
      return {
        allowed: false,
        reason: `usage metering unhealthy, all provider calls stopped: ${this.unhealthyReason}`,
      };
    }
    const limit =
      kind === "proactive"
        ? this.config.proactiveDailyTokenLimit
        : this.config.interactiveDailyTokenLimit;
    if (limit === null) {
      return { allowed: true };
    }
    const used = this.ledger.totalForDay(this.dayKey());
    if (used + estimatedTokens > limit) {
      return {
        allowed: false,
        reason: `daily token budget exceeded for ${kind} call: ${used}+${estimatedTokens} > ${limit} tokens on ${this.dayKey()}`,
      };
    }
    return { allowed: true };
  }

  /** 调用后记账；所有调用类型与 Provider 共享同一日桶。 */
  record(tokens: number): void {
    if (tokens <= 0) {
      return;
    }
    this.ledger.record(this.dayKey(), tokens);
  }

  /** 计量失效（无法核查用量）即停止后续调用，不虚称已封顶。 */
  markMeteringUnhealthy(reason: string): void {
    this.unhealthyReason = reason;
  }

  get meteringUnhealthyReason(): string | null {
    return this.unhealthyReason;
  }
}
