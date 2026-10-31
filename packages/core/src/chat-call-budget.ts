import type { ChatMessage } from "./chat-provider.js";

/**
 * 用量估算端口：Core 不绑定具体 Provider 的计量格式，
 * 由注入实现决定 token 估算口径（architecture §4.1 限额三层之一）。
 */
export interface UsageEstimator {
  estimateTokens(text: string): number;
}

/** 交互调用直接服务当前用户输入；主动调用无当前输入。 */
export type CallKind = "interactive" | "proactive";

export interface SingleCallLimit {
  maxInputTokens: number;
  maxOutputTokens: number;
}

/**
 * 出厂默认单次调用限额：交互与主动调用都默认受限（2026-10-31 决策，
 * architecture §4.1「用量与上下文限额三层配置化」第一层）。
 */
export const defaultSingleCallLimit: SingleCallLimit = {
  maxInputTokens: 4096,
  maxOutputTokens: 1024,
};

export interface ChatCallBudgetConfig {
  default: SingleCallLimit;
  /** 按 Provider ID 覆盖单次上限；未命中的 Provider 使用 default。 */
  byProvider: Record<string, SingleCallLimit>;
}

export type BudgetDecision = { allowed: true } | { allowed: false; reason: string };

/** 单次调用限额策略：在 Provider 调用前后做输入/输出预算检查。 */
export class ChatCallBudget {
  constructor(
    private readonly estimator: UsageEstimator,
    private readonly config: ChatCallBudgetConfig = { default: defaultSingleCallLimit, byProvider: {} },
  ) {}

  admitInput(providerId: string, kind: CallKind, messages: ChatMessage[]): BudgetDecision {
    const limit = this.limitFor(providerId);
    const inputTokens = messages.reduce((sum, message) => sum + this.estimator.estimateTokens(message.text), 0);
    if (inputTokens > limit.maxInputTokens) {
      return {
        allowed: false,
        reason: `single-call input budget exceeded for ${kind} call on provider "${providerId}": ${inputTokens} > ${limit.maxInputTokens} tokens`,
      };
    }
    return { allowed: true };
  }

  /**
   * 输出方向是事后用量核对：Core 端口不限制生成长度，Provider Adapter
   * 必须在自己的请求参数中设置输出上限；本检查在响应返回后核对，
   * 超限响应按阻止处理（丢弃/降级由调用方执行）。
   */
  admitOutput(providerId: string, kind: CallKind, text: string): BudgetDecision {
    const limit = this.limitFor(providerId);
    const outputTokens = this.estimator.estimateTokens(text);
    if (outputTokens > limit.maxOutputTokens) {
      return {
        allowed: false,
        reason: `single-call output budget exceeded for ${kind} call on provider "${providerId}": ${outputTokens} > ${limit.maxOutputTokens} tokens`,
      };
    }
    return { allowed: true };
  }

  private limitFor(providerId: string): SingleCallLimit {
    return this.config.byProvider[providerId] ?? this.config.default;
  }
}
