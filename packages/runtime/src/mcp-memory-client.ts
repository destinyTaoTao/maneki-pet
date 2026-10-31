import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  AssistantMemoryRecord,
  CallContext,
  ExternalMemoryProvider,
  MemoryItem,
  MemoryQuery,
  ProviderInfo,
} from "@maneki-pet/core";

export interface McpMemoryClientOptions {
  /** 记忆服务的 stdio 启动命令（可执行文件）与参数。 */
  command: string;
  args?: string[];
  /** 追加到子进程的环境变量（如服务端配置）。 */
  env?: Record<string, string>;
  /** MCP 工具名映射：真实服务的工具名可能不同，按配置适配。 */
  searchTool?: string;
  writeTool?: string;
  providerId?: string;
  /** ctx 无 deadline 时的兜底超时。 */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  method: string;
  params: unknown;
  ctx: CallContext | undefined;
  retries: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * stdio MCP 记忆客户端（票据 #46）：实现 Core 的 ExternalMemoryProvider 端口，
 * 连接用户自建记忆服务（initialize → tools/list → tools/call，行分帧 JSON-RPC 2.0）。
 * 取消/超时/错误语义遵循 §4.1：超时可区分、迟到结果不接收；服务进程崩溃时
 * 在途请求全部失败，下次调用自动重启进程。
 */
export class McpMemoryClient implements ExternalMemoryProvider {
  readonly info: ProviderInfo;

  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private initialized = false;
  private stopped = false;
  private initializing: Promise<void> | undefined;

  constructor(private readonly options: McpMemoryClientOptions) {
    this.info = {
      id: options.providerId ?? "external-memory-mcp",
      apiVersion: 1,
      locality: "local",
    };
  }

  async retrieve(query: MemoryQuery, ctx?: CallContext): Promise<{ items: MemoryItem[] }> {
    const result = await this.callTool(this.options.searchTool ?? "memory_search", {
      query: query.text,
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    }, ctx);
    return { items: parseItems(result) };
  }

  async write(record: AssistantMemoryRecord, ctx?: CallContext): Promise<void> {
    await this.callTool(this.options.writeTool ?? "memory_write", {
      kind: record.kind,
      summary: record.summary,
      ...(record.content !== undefined ? { content: record.content } : {}),
      occurredAt: record.occurredAt,
    }, ctx);
  }

  /** 停止后不再发起任何调用（关闭后端到端零调用）。 */
  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = undefined;
    this.initialized = false;
    if (child) {
      child.stdin.end();
      child.kill();
    }
  }

  private async callTool(name: string, args: Record<string, unknown>, ctx?: CallContext): Promise<unknown> {
    const result = await this.request("tools/call", { name, arguments: args }, ctx);
    const isError = (result as { isError?: boolean })?.isError === true;
    if (isError) {
      const text = extractFirstText(result);
      throw new Error(`memory tool "${name}" failed: ${text}`);
    }
    return result;
  }

  private async request(method: string, params: unknown, ctx?: CallContext): Promise<unknown> {
    return this.requestOnce(method, params, ctx, 0);
  }

  private async requestOnce(method: string, params: unknown, ctx: CallContext | undefined, retries: number): Promise<unknown> {
    if (this.stopped) {
      return Promise.reject(new Error("memory client stopped; refusing new calls"));
    }
    if (!this.initialized && method !== "initialize") {
      this.initializing = this.initializing ?? this.initialize(ctx).finally(() => {
        this.initializing = undefined;
      });
      await this.initializing;
    }
    const child = this.ensureChild();
    const id = this.nextId;
    this.nextId += 1;
    const fallback = this.options.requestTimeoutMs ?? 10_000;
    const timeoutMs = ctx ? Math.max(ctx.deadlineAtMs - Date.now(), 1) : fallback;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`memory rpc timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, params, ctx, retries, resolve, reject, timer });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }

  private async initialize(ctx?: CallContext): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "maneki-runtime", version: "0.1.0" },
    }, ctx);
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    this.initialized = true;
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null) {
      return this.child;
    }
    const child = spawn(this.options.command, this.options.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(this.options.env ? { env: { ...process.env, ...this.options.env } } : {}),
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    // 服务端 stderr 是日志通道，不进协议。
    child.stderr.on("data", () => undefined);
    child.on("exit", () => {
      // 进程在响应前死亡：在途请求换新进程重试一次（写入类非幂等风险由
      // 调用方的对账语义承担，重试仅一次），二次死亡才拒绝。
      const outstanding = [...this.pending.values()];
      this.pending.clear();
      this.initialized = false;
      this.child = undefined;
      for (const pending of outstanding) {
        clearTimeout(pending.timer);
        if (pending.retries < 1) {
          setImmediate(() => {
            this.requestOnce(pending.method, pending.params, pending.ctx, pending.retries + 1).then(
              pending.resolve,
              pending.reject,
            );
          });
        } else {
          pending.reject(new Error("memory server exited before responding"));
        }
      }
    });
    this.child = child;
    return child;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.dispatch(line);
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let message: { id?: unknown; error?: { code?: number; message?: string }; result?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(`memory rpc error ${message.error.code ?? "?"}: ${message.error.message ?? ""}`));
    } else {
      pending.resolve(message.result);
    }
  }
}

function extractFirstText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  return content?.find((part) => part.type === "text")?.text ?? "";
}

function parseItems(result: unknown): MemoryItem[] {
  const text = extractFirstText(result);
  if (text.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as { items?: MemoryItem[] };
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}
