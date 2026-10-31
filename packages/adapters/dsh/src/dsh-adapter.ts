/**
 * dsh 适配器（M2b）：观察 + 网关派发双模。
 *
 * - 未配置 gateway：观察适配器 v0（能力忠实 2026-10-31 活体 spike）。
 * - 配置 gateway（web profile base URL + 门禁 token）：升级为派发适配器——
 *   newTask/continueSession/reply 走 session/create+prompt（prompt.requestId
 *   = Maneki brokerRequestId，dsh 原生幂等键与 Broker 对齐）；cancel 走
 *   session/cancel；query 走 session/projections（asOfSeq + turnOutline，
 *   completeness=status_only：产物引用未验证）。
 * - 审批：approval:"native"——dsh 沙箱 workspace-write 内自动、越界
 *   fail-closed 需在 dsh web UI 审批（routeId 指向 web UI），活体验证见审计。
 * 数据边界：任务文本与工作区内容会发往 DeepSeek API（云端）。
 */
import {
  checkCapabilityConsistency,
  type AdapterCapabilities,
  type AdapterDataBoundary,
  type CallContext,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessSession,
  type TaskQueryResult,
  type TaskRef,
  type TaskRequest,
  type TaskSnapshot,
} from "@maneki-pet/core";

import { DshGatewayClient, type SessionProjections } from "./dsh-gateway-client.js";

export interface DshGatewayOptions {
  /** dsh web profile 的 base URL（如 http://127.0.0.1:18100）。 */
  baseUrl: string;
  /** 门禁 token（`dsh --profile web` 启动输出）。 */
  token: string;
  fetchImpl?: typeof fetch;
}

export interface DshAdapterOptions {
  /** 显式配置的观察会话列表（discover 返回它；空数组不代表接入就绪）。 */
  sessions?: HarnessSession[];
  adapterId?: string;
  /** 网关派发配置：提供后升级为派发适配器。 */
  gateway?: DshGatewayOptions;
}

const OBSERVATION_CAPABILITIES: AdapterCapabilities = {
  events: true,
  newTask: false,
  continueSession: false,
  reply: false,
  query: "none",
  cancel: false,
  deduplicateSubmit: false,
  approval: "none",
  sessionOverview: false,
};

const DISPATCH_CAPABILITIES: AdapterCapabilities = {
  events: true,
  newTask: true,
  continueSession: true,
  reply: true,
  query: "status_only",
  cancel: true,
  deduplicateSubmit: false,
  approval: "native",
  sessionOverview: false,
};

interface TaskRecord {
  sessionId: string;
  prompt: string;
  cancelled: boolean;
}

export class DshAdapter implements HarnessAdapter {
  readonly id: string;
  readonly apiVersion = 1 as const;
  readonly dataBoundary: AdapterDataBoundary = {
    processing: "cloud",
    destinations: ["api.deepseek.com"],
  };
  readonly capabilities: AdapterCapabilities;

  private readonly gateway: DshGatewayClient | undefined;
  /** brokerRequestId → 任务登记（进程内；持久化归 Runtime）。 */
  private readonly tasks = new Map<string, TaskRecord>();

  constructor(private readonly options: DshAdapterOptions = {}) {
    this.id = options.adapterId ?? "dsh";
    this.gateway = options.gateway
      ? new DshGatewayClient({ baseUrl: options.gateway.baseUrl, token: options.gateway.token, ...(options.gateway.fetchImpl ? { fetchImpl: options.gateway.fetchImpl } : {}) })
      : undefined;
    this.capabilities = options.gateway ? DISPATCH_CAPABILITIES : OBSERVATION_CAPABILITIES;
    const problems = checkCapabilityConsistency(this);
    if (problems.length > 0) {
      throw new Error(`dsh adapter capability inconsistency: ${problems.join("; ")}`);
    }
  }

  async discover(_ctx: CallContext): Promise<HarnessSession[]> {
    return this.options.sessions ?? [];
  }

  /**
   * headless/网关模式均无全局外部事件源：受控任务的事件经 query 轮询
   * （asOfSeq 提供源位置）由 Runtime 的 Broker 驱动；此处登记回调并返回注销函数。
   */
  async subscribe(_cb: (event: HarnessEvent) => void, _ctx: CallContext): Promise<() => void> {
    return () => undefined;
  }

  async submit(req: TaskRequest, _ctx: CallContext): Promise<TaskRef> {
    if (!this.gateway) {
      throw new Error("dsh adapter: dispatch requires gateway configuration");
    }
    if (req.target.kind !== "new") {
      throw new Error("dsh adapter: existing-session targets require continueSession verification (M2b pending)");
    }
    const created = await this.gateway.createSession({ cwd: req.target.workdir });
    const sessionId = created.sessionId ?? created.session?.sessionId;
    if (!sessionId) {
      throw new Error("dsh gateway session/create returned no sessionId");
    }
    const promptText = req.prompt;
    await this.gateway.prompt({
      sessionId,
      requestId: req.brokerRequestId,
      mode: "queue",
      content: [{ type: "text", text: promptText }],
    });
    this.tasks.set(req.brokerRequestId, { sessionId, prompt: promptText, cancelled: false });
    return { brokerRequestId: req.brokerRequestId, taskId: sessionId, sessionId };
  }

  async query(key: { brokerRequestId: string }, _ctx: CallContext): Promise<TaskQueryResult> {
    if (!this.gateway) {
      throw new Error("dsh adapter: query requires gateway configuration");
    }
    const record = this.tasks.get(key.brokerRequestId);
    if (!record) {
      return { outcome: "not_found" };
    }
    const projections: SessionProjections = await this.gateway.projections(record.sessionId);
    const outline = projections.values?.turnOutline ?? [];
    const own = [...outline].reverse().find((entry) => entry.prompt === record.prompt);
    const status = record.cancelled ? "cancelled" : projections.values?.turnOutline?.length && own ? "completed" : "running";
    const snapshot: TaskSnapshot = {
      ref: { brokerRequestId: key.brokerRequestId, taskId: record.sessionId, sessionId: record.sessionId },
      status,
      completeness: "status_only",
      sourcePosition: { streamId: `dsh-gateway-${record.sessionId}`, sequence: projections.asOfSeq ?? 0 },
      ...(status === "completed" && own
        ? { result: { summary: own.response, artifacts: [] } }
        : {}),
    };
    return { outcome: "found", snapshot };
  }

  async reply(ref: TaskRef, input: { inputId: string; text: string }, _ctx: CallContext): Promise<void> {
    if (!this.gateway) {
      throw new Error("dsh adapter: reply requires gateway configuration");
    }
    await this.gateway.prompt({
      sessionId: ref.sessionId,
      requestId: input.inputId,
      mode: "steer",
      content: [{ type: "text", text: input.text }],
    });
  }

  async cancel(ref: TaskRef, _ctx: CallContext): Promise<void> {
    if (!this.gateway) {
      throw new Error("dsh adapter: cancel requires gateway configuration");
    }
    const record = this.tasks.get(ref.brokerRequestId);
    await this.gateway.cancelSession(ref.sessionId);
    if (record) {
      record.cancelled = true;
    }
  }
}
