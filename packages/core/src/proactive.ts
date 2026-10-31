/**
 * 主动性引擎（architecture §4.3）：主动性 = 已验证触发器 × 防打扰预算 × 可用通道。
 * 触发决策全部由确定性规则做出；LLM 仅在触发后生成话术，失败回退固定文案，
 * 不阻止真实提醒与通知。勿扰抑制主动打扰，不禁用户主动交互。
 */
export type ProactiveCategory = "murmur" | "daily_briefing";

export interface ProactiveChannelState {
  bubble: boolean;
  notification: boolean;
  tts: boolean;
}

export interface PhrasingRequest {
  category: ProactiveCategory;
  facts: string[];
}

/** 话术端口：只生成文案，绝不决定触发与否。 */
export interface PhrasingProvider {
  phrase(request: PhrasingRequest): Promise<string>;
}

export interface MurmurCategoryConfig {
  enabled: boolean;
  idleThresholdMs: number;
}

export interface BriefingCategoryConfig {
  enabled: boolean;
  scheduledHour: number;
  scheduledMinute: number;
}

export interface ProactiveConfig {
  murmur: MurmurCategoryConfig;
  daily_briefing: BriefingCategoryConfig;
  murmurBudget: { minIntervalMs: number; maxPerHour: number };
}

/** 出厂默认：碎碎念低频开启，每日简报默认关闭（2026-10-31 决策）。 */
export const defaultProactiveConfig: ProactiveConfig = {
  murmur: { enabled: true, idleThresholdMs: 45 * 60 * 1000 },
  daily_briefing: { enabled: false, scheduledHour: 9, scheduledMinute: 0 },
  murmurBudget: { minIntervalMs: 2 * 60 * 60 * 1000, maxPerHour: 1 },
};

export type TriggerBlockReason =
  | "disabled"
  | "dnd"
  | "no-channel"
  | "budget"
  | "no-trigger"
  | "not-due"
  | "already-sent"
  | "no-content";

export type TriggerDecision = { fire: true } | { fire: false; reason: TriggerBlockReason };

/** 简报内容只来自确定性数据（任务状态、到期提醒、会话动态），不截屏不监听内容。 */
export type BriefingItemKind = "task_status" | "reminder" | "session_activity";

export interface BriefingItem {
  kind: BriefingItemKind;
  text: string;
}

/** 简报数据源端口：由注入实现从已验证数据汇总，Core 不做 IO。 */
export interface BriefingSource {
  collect(now: Date): BriefingItem[];
}

export interface ProactiveEngineDeps {
  clock: () => Date;
  config?: ProactiveConfig;
  channels: () => ProactiveChannelState;
  dnd: () => boolean;
  phrasing?: PhrasingProvider;
  fallbackCopy: Record<ProactiveCategory, string>;
}

export class ProactiveEngine {
  private readonly config: ProactiveConfig;
  private readonly murmurFireTimes: number[] = [];
  private lastBriefingDayKey: string | null = null;
  private readonly deps: ProactiveEngineDeps;

  constructor(deps: ProactiveEngineDeps) {
    this.deps = deps;
    this.config = deps.config ?? defaultProactiveConfig;
  }

  hasEnabledChannel(): boolean {
    const channels = this.deps.channels();
    return channels.bubble || channels.notification || channels.tts;
  }

  /** 碎碎念：确定性触发（空闲时长规则），预算与勿扰内静默。 */
  evaluateMurmur(input: { idleMs: number }): TriggerDecision {
    if (!this.config.murmur.enabled) {
      return { fire: false, reason: "disabled" };
    }
    if (this.deps.dnd()) {
      return { fire: false, reason: "dnd" };
    }
    if (!this.hasEnabledChannel()) {
      return { fire: false, reason: "no-channel" };
    }
    const nowMs = this.deps.clock().getTime();
    const withinMinInterval = this.murmurFireTimes.some(
      (time) => nowMs - time < this.config.murmurBudget.minIntervalMs,
    );
    const perHour = this.murmurFireTimes.filter((time) => nowMs - time < 3_600_000).length;
    if (withinMinInterval || perHour >= this.config.murmurBudget.maxPerHour) {
      return { fire: false, reason: "budget" };
    }
    if (input.idleMs < this.config.murmur.idleThresholdMs) {
      return { fire: false, reason: "no-trigger" };
    }
    return { fire: true };
  }

  /** 触发并送达后记账（由 Shell 调用，保持 evaluate 纯决策）。 */
  noteMurmurFired(): void {
    this.murmurFireTimes.push(this.deps.clock().getTime());
  }

  /**
   * 每日简报：到配置时间点且当日未发、有确定性的新内容才触发
   * （默认关闭；当日失效、无料不发）。时间点按注入时钟的 UTC 时:分
   * 比较，本地时区换算由装配层完成。
   */
  evaluateBriefing(source: BriefingSource): TriggerDecision {
    const briefing = this.config.daily_briefing;
    if (!briefing.enabled) {
      return { fire: false, reason: "disabled" };
    }
    if (this.deps.dnd()) {
      return { fire: false, reason: "dnd" };
    }
    if (!this.hasEnabledChannel()) {
      return { fire: false, reason: "no-channel" };
    }
    const now = this.deps.clock();
    const due =
      now.getUTCHours() > briefing.scheduledHour ||
      (now.getUTCHours() === briefing.scheduledHour && now.getUTCMinutes() >= briefing.scheduledMinute);
    if (!due) {
      return { fire: false, reason: "not-due" };
    }
    if (this.lastBriefingDayKey === this.dayKey()) {
      return { fire: false, reason: "already-sent" };
    }
    if (source.collect(now).length === 0) {
      return { fire: false, reason: "no-content" };
    }
    return { fire: true };
  }

  /** 送达后标记当日已发；次日自动失效（当日单次）。 */
  markBriefingSent(): void {
    this.lastBriefingDayKey = this.dayKey();
  }

  briefingStatus(): { dayKey: string; sentToday: boolean } {
    const dayKey = this.dayKey();
    return { dayKey, sentToday: this.lastBriefingDayKey === dayKey };
  }

  /** 话术生成：LLM 仅写话术；未配置或失败回退固定文案。 */
  async compose(category: ProactiveCategory, facts: string[] = []): Promise<string> {
    const phrasing = this.deps.phrasing;
    if (phrasing) {
      try {
        return await phrasing.phrase({ category, facts });
      } catch {
        // 回退固定文案，不阻塞主动流程。
      }
    }
    return this.deps.fallbackCopy[category];
  }

  protected dayKey(): string {
    return this.deps.clock().toISOString().slice(0, 10);
  }
}
