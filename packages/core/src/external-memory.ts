import type { CallContext, ProviderInfo } from "./chat-provider.js";

/**
 * 外挂记忆端口（architecture §4.1/§4.4，2026-10-31 决策）：
 * 承载背景知识与长期个人记忆，不承载提醒/记事的结构化事实与调度；
 * 内容按数据渲染，不能提升权限或被当系统指令。
 */
export type MemorySourceTag = "explicit" | "implicit";

export interface MemoryItem {
  id: string;
  text: string;
  source: MemorySourceTag;
}

export interface MemoryQuery {
  text: string;
  limit?: number;
}

/** 助理侧记录来源，类型上不包含 harness 会话存储（不整包复制，§4.4）。 */
export type AssistantRecordKind = "main_chat" | "sub_session" | "task" | "note";

export interface AssistantMemoryRecord {
  kind: AssistantRecordKind;
  summary: string;
  /** 原始正文；仅在"全量原始"档写回。 */
  content?: string;
  occurredAt: string;
}

/** 写回粒度三档：关闭 / 仅摘要 / 全量原始（默认全量原始，用户 2026-10-31 决策）。 */
export type WritebackGranularity = "off" | "summary" | "raw";

export interface ExternalMemoryConfig {
  readEnabled: boolean;
  writeEnabled: boolean;
  explicitMemoryEnabled: boolean;
  implicitReferenceEnabled: boolean;
  writebackGranularity: WritebackGranularity;
}

export const defaultExternalMemoryConfig: ExternalMemoryConfig = {
  readEnabled: true,
  writeEnabled: true,
  explicitMemoryEnabled: true,
  implicitReferenceEnabled: true,
  writebackGranularity: "raw",
};

export interface ExternalMemoryProvider {
  info: ProviderInfo;
  retrieve(query: MemoryQuery, ctx: CallContext): Promise<{ items: MemoryItem[] }>;
  write(record: AssistantMemoryRecord, ctx: CallContext): Promise<void>;
}

export type MemoryContextResult =
  | { outcome: "ok"; items: MemoryItem[] }
  | { outcome: "skipped"; reason: string }
  | { outcome: "degraded"; reason: string };

export type MemoryWriteResult =
  | { outcome: "ok" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "degraded"; reason: string };

export interface MemoryContextServiceDeps {
  provider?: ExternalMemoryProvider;
  config?: ExternalMemoryConfig;
  /** 毫秒时钟，用于迟到结果判定；默认 Date.now。 */
  clock?: () => number;
}

/**
 * 外挂记忆上下文服务：外挂关闭/故障/迟到时降级为空结果，
 * 提醒、记事、文字派发等核心流程不受影响（分层并存，§4.4）。
 */
export class MemoryContextService {
  private readonly provider: ExternalMemoryProvider | undefined;
  private readonly config: ExternalMemoryConfig;
  private readonly clock: () => number;

  constructor(deps: MemoryContextServiceDeps = {}) {
    this.provider = deps.provider;
    this.config = deps.config ?? defaultExternalMemoryConfig;
    this.clock = deps.clock ?? Date.now;
  }

  async retrieveContext(query: MemoryQuery, ctx: CallContext): Promise<MemoryContextResult> {
    if (!this.config.readEnabled) {
      return { outcome: "skipped", reason: "external memory read disabled" };
    }
    if (!this.config.explicitMemoryEnabled && !this.config.implicitReferenceEnabled) {
      return { outcome: "skipped", reason: "both explicit memory and implicit reference disabled" };
    }
    const provider = this.provider;
    if (!provider) {
      return { outcome: "degraded", reason: "no external memory provider configured" };
    }
    let items: MemoryItem[];
    try {
      const response = await provider.retrieve(query, ctx);
      if (this.isLate(ctx)) {
        return { outcome: "degraded", reason: "late retrieval result dropped after deadline" };
      }
      items = response.items;
    } catch (error) {
      return { outcome: "degraded", reason: `external memory retrieve failed: ${describe(error)}` };
    }
    const filtered = items.filter((item) =>
      item.source === "explicit" ? this.config.explicitMemoryEnabled : this.config.implicitReferenceEnabled,
    );
    return { outcome: "ok", items: filtered };
  }

  async writeback(record: AssistantMemoryRecord, ctx: CallContext): Promise<MemoryWriteResult> {
    if (!this.config.writeEnabled) {
      return { outcome: "skipped", reason: "external memory write disabled" };
    }
    if (this.config.writebackGranularity === "off") {
      return { outcome: "skipped", reason: "writeback granularity off" };
    }
    const provider = this.provider;
    if (!provider) {
      return { outcome: "degraded", reason: "no external memory provider configured" };
    }
    const outgoing: AssistantMemoryRecord =
      this.config.writebackGranularity === "summary"
        ? { kind: record.kind, summary: record.summary, occurredAt: record.occurredAt }
        : record;
    try {
      await provider.write(outgoing, ctx);
      if (this.isLate(ctx)) {
        return { outcome: "degraded", reason: "late writeback completion after deadline" };
      }
    } catch (error) {
      return { outcome: "degraded", reason: `external memory write failed: ${describe(error)}` };
    }
    return { outcome: "ok" };
  }

  private isLate(ctx: CallContext): boolean {
    return this.clock() > ctx.deadlineAtMs || ctx.signal.aborted;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
