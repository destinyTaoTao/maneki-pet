/** dsh Adapter：可显式接入宿主事件；执行与恢复能力保持关闭。 */
import {
  checkCapabilityConsistency,
  type AdapterCapabilities,
  type AdapterDataBoundary,
  type CallContext,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessEventPayload,
  type HarnessSession,
  type TaskQueryResult,
  type TaskRef,
  type TaskRequest,
} from "@maneki-pet/core";

export interface DshGatewayOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface DshAdapterOptions {
  sessions?: HarnessSession[];
  adapterId?: string;
  /** 为兼容旧配置保留；网关配置本身不授予执行能力。 */
  gateway?: DshGatewayOptions;
  eventSource?: {
    subscribe(listener: (entry: DshSessionEvent) => void, ctx: CallContext): () => void;
  };
}

/** dsh 0.2.1-rc.5 的 session/event 观察边界；不包含 prompt 或工具输出。 */
export interface DshSessionEvent {
  sessionId: string;
  event: { seq: number; type: string; data: Record<string, unknown> };
}

const UNAVAILABLE_CAPABILITIES: AdapterCapabilities = {
  events: false,
  newTask: false,
  continueSession: false,
  reply: false,
  query: "none",
  cancel: false,
  deduplicateSubmit: false,
  approval: "none",
  sessionOverview: false,
};

function unsupported(): Error {
  return Object.assign(new Error("dsh operation is not verified"), { code: "UNSUPPORTED" });
}

export class DshAdapter implements HarnessAdapter {
  readonly id: string;
  readonly apiVersion = 1 as const;
  readonly dataBoundary: AdapterDataBoundary = { processing: "unknown", destinations: [] };
  readonly capabilities: AdapterCapabilities;

  constructor(private readonly options: DshAdapterOptions = {}) {
    this.id = options.adapterId ?? "dsh";
    this.capabilities = { ...UNAVAILABLE_CAPABILITIES, events: options.eventSource !== undefined };
    const problems = checkCapabilityConsistency(this);
    if (problems.length) throw new Error(`dsh adapter capability inconsistency: ${problems.join("; ")}`);
  }

  async discover(_ctx: CallContext): Promise<HarnessSession[]> {
    return this.options.sessions ?? [];
  }

  async subscribe(cb: (event: HarnessEvent) => void, ctx: CallContext): Promise<() => void> {
    if (!this.options.eventSource) throw unsupported();
    ctx.signal.throwIfAborted();
    const remaining = ctx.deadlineAtMs - Date.now();
    if (remaining <= 0) throw new DOMException("dsh subscription deadline exceeded", "TimeoutError");
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const stop = (): void => {
      active = false;
      ctx.signal.removeEventListener("abort", stop);
      unsubscribe?.();
      unsubscribe = undefined;
    };
    ctx.signal.addEventListener("abort", stop, { once: true });
    try {
      unsubscribe = this.options.eventSource.subscribe(({ sessionId, event }) => {
        if (!active) return;
        const payload = sessionPayload(event);
        if (!payload || !sessionId || !Number.isSafeInteger(event.seq) || event.seq < 0) return;
        const turn = event.data.turn;
        if (payload.type.startsWith("task.") && (!Number.isSafeInteger(turn) || (turn as number) < 0)) return;
        cb({
          eventId: `${this.id}:${sessionId}:${event.seq}`,
          adapterId: this.id,
          sessionId,
          ...(typeof turn === "number" ? { taskId: `${sessionId}:${turn}` } : {}),
          occurredAt: new Date().toISOString(),
          sequence: event.seq,
          streamId: `dsh-session-v4:${sessionId}`,
          payload,
        });
      }, ctx);
      if (ctx.signal.aborted) { stop(); ctx.signal.throwIfAborted(); }
      return stop;
    } catch (error) {
      stop();
      throw error;
    }
  }

  async submit(_req: TaskRequest, _ctx: CallContext): Promise<TaskRef> {
    throw unsupported();
  }

  async query(_key: { brokerRequestId: string }, _ctx: CallContext): Promise<TaskQueryResult> {
    throw unsupported();
  }

  async reply(_ref: TaskRef, _input: { inputId: string; text: string }, _ctx: CallContext): Promise<void> {
    throw unsupported();
  }

  async cancel(_ref: TaskRef, _ctx: CallContext): Promise<void> {
    throw unsupported();
  }
}

function sessionPayload(event: DshSessionEvent["event"]): HarnessEventPayload | undefined {
  switch (event.type) {
    case "turn/start": return { type: "task.started" };
    case "step/start": return { type: "session.busy", state: "thinking" };
    case "tool/call": return { type: "session.busy", state: event.data.name === "ask_user_question" ? "waiting" : "working" };
    case "approval/decided": return { type: "session.busy", state: "working" };
    case "approval/asked": return { type: "session.busy", state: "waiting" };
    case "turn/end": {
      const reason = event.data.reason as { kind?: unknown } | undefined;
      switch (reason?.kind) {
        case "completed": return { type: "task.completed" };
        case "aborted": return { type: "task.cancelled" };
        case "blocked": return { type: "session.busy", state: "waiting" };
        case "error": return { type: "task.error", message: "dsh 任务失败，请在宿主查看详情" };
        default: return { type: "task.error", message: "dsh 任务中断或未正常完成，请在宿主核查" };
      }
    }
    default: return undefined;
  }
}
