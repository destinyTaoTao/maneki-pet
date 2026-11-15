import type { UsageEstimator } from "./chat-call-budget.js";
import type { ChatMessage } from "./chat-provider.js";

/** 主会话与子会话共用同一上下文预算规则（2026-10-31 决策）。 */
export type ContextSessionKind = "main" | "sub";

/** 超限策略：摘要压缩（默认）/ 截断 / 拒绝（architecture §4.1 限额三层之二）。 */
export type ContextOverflowStrategy = "summarize" | "truncate" | "reject";

/** 摘要端口：由注入实现完成压缩；摘要文本按数据处理，不承载权限指令。 */
export interface Summarizer {
  summarize(messages: ChatMessage[]): Promise<string>;
}

export interface ContextBudgetConfig {
  maxTokens: number;
  strategy: ContextOverflowStrategy;
}

export const defaultContextBudgetConfig: ContextBudgetConfig = {
  maxTokens: 8192,
  strategy: "summarize",
};

export interface ContextAssembly {
  messages: ChatMessage[];
  notice?: string;
}

export type ContextAssemblyResult =
  | { outcome: "assembled"; assembly: ContextAssembly }
  | { outcome: "rejected"; reason: string };

export interface ConversationContextAssemblerDeps {
  estimator: UsageEstimator;
  summarizer?: Summarizer;
  config: ContextBudgetConfig;
}

export class ConversationContextAssembler {
  constructor(private readonly deps: ConversationContextAssemblerDeps) {}

  async assemble(
    sessionKind: ContextSessionKind,
    history: ChatMessage[],
    incoming: ChatMessage[],
  ): Promise<ContextAssemblyResult> {
    const { estimator, config } = this.deps;
    const estimate = (messages: ChatMessage[]): number =>
      messages.reduce((sum, message) => sum + estimator.estimateTokens(message.text), 0);

    const incomingTokens = estimate(incoming);
    if (incomingTokens > config.maxTokens) {
      return {
        outcome: "rejected",
        reason: `context budget exceeded: incoming alone ${incomingTokens} > ${config.maxTokens} tokens for ${sessionKind} session`,
      };
    }

    const totalTokens = estimate(history) + incomingTokens;
    if (totalTokens <= config.maxTokens) {
      return { outcome: "assembled", assembly: { messages: [...history, ...incoming] } };
    }

    if (config.strategy === "reject") {
      return {
        outcome: "rejected",
        reason: `context budget exceeded for ${sessionKind} session: ${totalTokens} > ${config.maxTokens} tokens; strategy=reject`,
      };
    }

    const historyBudget = config.maxTokens - incomingTokens;
    const keepCount = this.maxSuffixCount(history, historyBudget);

    if (config.strategy === "truncate") {
      return {
        outcome: "assembled",
        assembly: withNotice([...history.slice(history.length - keepCount), ...incoming], "oldest history truncated to fit context budget"),
      };
    }

    const summarizer = this.deps.summarizer;
    if (!summarizer) {
      return {
        outcome: "rejected",
        reason: `context budget exceeded and no summarizer available for ${sessionKind} session: ${totalTokens} > ${config.maxTokens} tokens`,
      };
    }

    let droppedCount = history.length - keepCount;
    // 每次为摘要腾位后都重做扩大后的前缀摘要；前缀只会增长，最多覆盖全部历史。
    for (;;) {
      let summaryText: string;
      try {
        summaryText = await summarizer.summarize(history.slice(0, droppedCount));
      } catch {
        return {
          outcome: "rejected",
          reason: `context budget exceeded and summarizer failed for ${sessionKind} session: ${totalTokens} > ${config.maxTokens} tokens`,
        };
      }

      const summaryMessage: ChatMessage = { role: "system", text: `[conversation summary] ${summaryText}` };
      const kept = history.slice(droppedCount);
      const finalMessages = [summaryMessage, ...kept, ...incoming];
      const finalTokens = estimate(finalMessages);
      if (finalTokens <= config.maxTokens) {
        return {
          outcome: "assembled",
          assembly: withNotice(finalMessages, "oldest history summarized to fit context budget"),
        };
      }
      if (kept.length === 0) {
        return {
          outcome: "rejected",
          reason: `context budget still exceeded after summarization for ${sessionKind} session: ${finalTokens} > ${config.maxTokens} tokens`,
        };
      }
      const remainingBudget = config.maxTokens - estimate([summaryMessage, ...incoming]);
      const remainingCount = this.maxSuffixCount(kept, remainingBudget);
      droppedCount += kept.length - remainingCount;
    }
  }

  private maxSuffixCount(messages: ChatMessage[], budgetTokens: number): number {
    let used = 0;
    let count = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message) {
        break;
      }
      const tokens = this.deps.estimator.estimateTokens(message.text);
      if (used + tokens > budgetTokens) {
        break;
      }
      used += tokens;
      count += 1;
    }
    return count;
  }
}

function withNotice(messages: ChatMessage[], notice: string): ContextAssembly {
  return { messages, notice };
}
