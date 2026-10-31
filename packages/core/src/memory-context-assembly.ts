import type { CallContext, ChatMessage } from "./chat-provider.js";
import type {
  ContextAssemblyResult,
  ContextSessionKind,
  ConversationContextAssembler,
} from "./context-window.js";
import type { MemoryContextService, MemoryQuery } from "./external-memory.js";

export interface MemoryAwareContextAssemblerDeps {
  assembler: ConversationContextAssembler;
  memory: MemoryContextService;
}

export interface MemoryAwareAssemblyInput {
  sessionKind: ContextSessionKind;
  history: ChatMessage[];
  incoming: ChatMessage[];
  query: MemoryQuery;
  ctx: CallContext;
}

/**
 * 检索注入与上下文组装的组合 seam（票据 #45）：先安全检索外挂记忆，
 * 命中条目作为数据前缀注入（不承载权限指令），再统一走上下文预算组装。
 * 外挂关闭/失败/迟到时降级为不注入，组装照常（architecture §4.4 分层并存）。
 */
export class MemoryAwareContextAssembler {
  constructor(private readonly deps: MemoryAwareContextAssemblerDeps) {}

  async assemble(input: MemoryAwareAssemblyInput): Promise<ContextAssemblyResult> {
    const memoryResult = await this.deps.memory.retrieveContext(input.query, input.ctx);
    const memoryMessages: ChatMessage[] =
      memoryResult.outcome === "ok"
        ? memoryResult.items.map((item) => ({
            role: "system",
            text: `[background memory] ${item.text}`,
          }))
        : [];
    return this.deps.assembler.assemble(
      input.sessionKind,
      [...memoryMessages, ...input.history],
      input.incoming,
    );
  }
}
