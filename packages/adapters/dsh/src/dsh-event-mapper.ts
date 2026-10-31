/**
 * dsh headless `--json` ndjson 行 → HarnessEvent 映射（纯函数）。
 * 事件形状依据 2026-10-31 活体 spike（dsh 0.2.1-rc.5，审计记录）：
 *   {"type":"session","sessionId","cwd"}
 *   {"type":"status","phase":"turn_start|step_start|step_end|turn_end","turn","step","reason":{kind,error}}
 *   {"type":"thinking"|"text","text"}
 *   {"type":"tool_call","callId","tool","input"} / {"type":"tool_result","callId","status","result"}
 *   {"type":"final","text"} / {"type":"error","message"}
 * 映射决策：turn_start→task.started；thinking→session.busy(thinking)；
 * tool_call→session.busy(working)+task.progress；text→task.progress；
 * turn_end(error)→task.error；error→task.error；final→task.completed；
 * step_end（usage 计量）与 tool_result(completed) 不进事件流（防洪泛）。
 */
import type { HarnessEvent, HarnessEventPayload } from "@maneki-pet/core";

const PROGRESS_SUMMARY_MAX = 200;

export interface DshEventMapperOptions {
  adapterId: string;
  /** headless 一次运行一个任务：taskId 即 sessionId（session 行到达后确定）。 */
  streamId?: string;
  now?: () => Date;
}

export class DshEventMapper {
  private sequence = 0;
  private sessionId: string | undefined;

  constructor(private readonly options: DshEventMapperOptions) {}

  /** 解析并映射一行 ndjson；无法映射/会话未知的行返回空数组。 */
  mapLine(rawLine: string): HarnessEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      return [];
    }
    if (typeof parsed !== "object" || parsed === null) {
      return [];
    }
    const line = parsed as Record<string, unknown>;
    const type = line.type;

    if (type === "session" && typeof line.sessionId === "string") {
      this.sessionId = line.sessionId;
      return [];
    }
    if (this.sessionId === undefined) {
      return [];
    }

    if (type === "status") {
      return this.mapStatus(line);
    }
    if (type === "thinking") {
      return [this.emit({ type: "session.busy", state: "thinking" })];
    }
    if (type === "text" && typeof line.text === "string") {
      return [this.emit({ type: "task.progress", summary: truncate(line.text) })];
    }
    if (type === "tool_call" && typeof line.tool === "string") {
      return [
        this.emit({ type: "session.busy", state: "working" }),
        this.emit({ type: "task.progress", summary: truncate(`tool ${line.tool}`) }),
      ];
    }
    if (type === "tool_result") {
      const status = line.status;
      if (status === "error") {
        return [this.emit({ type: "task.progress", summary: truncate(`tool failed: ${describe(line.result)}`) })];
      }
      return [];
    }
    if (type === "final" && typeof line.text === "string") {
      return [this.emit({ type: "task.completed", summary: line.text })];
    }
    if (type === "error" && typeof line.message === "string") {
      return [this.emit({ type: "task.error", message: line.message })];
    }
    return [];
  }

  private mapStatus(line: Record<string, unknown>): HarnessEvent[] {
    const phase = line.phase;
    if (phase === "turn_start") {
      const summary = describeTurn(line);
      return [this.emit(summary !== undefined ? { type: "task.started", summary } : { type: "task.started" })];
    }
    if (phase === "turn_end") {
      const reason = line.reason as { kind?: string; error?: { message?: string } } | undefined;
      if (reason?.kind === "error") {
        const message = reason.error?.message ?? "dsh turn failed";
        return [this.emit({ type: "task.error", message })];
      }
      return [];
    }
    return [];
  }

  private emit(payload: HarnessEventPayload): HarnessEvent {
    this.sequence += 1;
    const sessionId = this.sessionId as string;
    return {
      eventId: `${this.options.adapterId}-${sessionId}-${this.sequence}`,
      adapterId: this.options.adapterId,
      sessionId,
      taskId: sessionId,
      occurredAt: (this.options.now ?? (() => new Date()))().toISOString(),
      sequence: this.sequence,
      streamId: this.options.streamId ?? `dsh-headless-${sessionId}`,
      payload,
    };
  }

  get knownSessionId(): string | undefined {
    return this.sessionId;
  }
}

function describeTurn(line: Record<string, unknown>): string | undefined {
  return typeof line.turn === "number" ? `turn ${line.turn} started` : undefined;
}

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string): string {
  return text.length <= PROGRESS_SUMMARY_MAX ? text : `${text.slice(0, PROGRESS_SUMMARY_MAX)}…`;
}
