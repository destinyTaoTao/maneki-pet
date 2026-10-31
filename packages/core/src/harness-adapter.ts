/**
 * Harness Adapter 契约（architecture §5.1/§5.2 的代码化转写，v1）：
 * 事件观察、新建任务、继续会话、回答输入、状态查询、取消、审批桥接
 * 是不同能力；每个适配器记录已验证的宿主版本、平台、数据边界与限制。
 * 未声明/未实现的操作在注册时一致性校验后返回 UNSUPPORTED。
 */
import type { CallContext } from "./chat-provider.js";

export interface HarnessSession {
  sessionId: string;
  workdir: string;
}

export type TaskTarget =
  | { kind: "new"; workdir: string }
  | { kind: "existing"; sessionId: string; workdir: string };

export interface TaskRequest {
  brokerRequestId: string;
  prompt: string;
  target: TaskTarget;
}

export interface TaskRef {
  brokerRequestId: string;
  taskId: string;
  sessionId: string;
}

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type TaskCompleteness = "full" | "status_only";

export interface PendingApprovalNative {
  mode: "native";
  routeId: string;
}

export interface PendingApprovalBridge {
  mode: "bridge";
  request: PermissionRequest;
}

export interface TaskSnapshot {
  ref: TaskRef;
  status: TaskStatus;
  completeness: TaskCompleteness;
  sourcePosition?: { streamId: string; sequence: number };
  result?: { summary?: string; artifacts: string[] };
  pendingInput?: { inputId: string; question: string };
  pendingApproval?: PendingApprovalNative | PendingApprovalBridge;
}

export type TaskQueryResult =
  | { outcome: "found"; snapshot: TaskSnapshot }
  | { outcome: "not_found" | "unknown" };

export type PermissionOperationKind =
  | "process"
  | "file_write"
  | "file_delete"
  | "network"
  | "payment"
  | "other";

export interface PermissionRequest {
  permissionId: string;
  operationId: string;
  sessionId: string;
  taskId: string;
  operation: {
    kind: PermissionOperationKind;
    workdir: string;
    executable?: string;
    args?: string[];
    rawCommand?: string;
    targets: string[];
    contentDigest?: string;
    payment?: { amountDecimal: string; currency: string };
    description: string;
  };
  operationDigest: string;
  expiresAt: string;
}

export interface PermissionDecision {
  operationId: string;
  permissionId: string;
  operationDigest: string;
  decision: "allow_once" | "deny";
}

export interface OperationSnapshot {
  operationId: string;
  approval: "pending" | "allowed" | "denied" | "expired";
  execution: "not_started" | "in_progress" | "completed" | "unknown";
  result?: { outcome: "succeeded" | "failed"; summary?: string };
}

export type OperationQueryResult =
  | { outcome: "found"; snapshot: OperationSnapshot }
  | { outcome: "not_found" | "unknown" };

export type HarnessEventPayload =
  | { type: "task.started" | "task.progress"; summary?: string }
  | { type: "task.needs_input"; inputId: string; question: string }
  | { type: "permission.requested"; mode: "native"; routeId: string }
  | { type: "permission.requested"; mode: "bridge"; request: PermissionRequest }
  | { type: "task.completed"; summary?: string; artifacts?: string[] }
  | { type: "task.error"; message: string }
  | { type: "task.cancelled" }
  | { type: "session.idle" }
  | { type: "session.busy"; state: "thinking" | "working" | "waiting" };

export interface HarnessEvent {
  eventId: string;
  adapterId: string;
  sessionId: string;
  taskId?: string;
  brokerRequestId?: string;
  occurredAt: string;
  sequence?: number;
  streamId?: string;
  payload: HarnessEventPayload;
}

/** 能力声明（§5.1）：与方法在注册时一致性校验；approval none 只允许观察/表达。 */
export interface AdapterCapabilities {
  events: boolean;
  newTask: boolean;
  continueSession: boolean;
  reply: boolean;
  query: "full" | "status_only" | "none";
  cancel: boolean;
  deduplicateSubmit: boolean;
  approval: "native" | "bridge" | "none";
  sessionOverview: boolean;
}

export interface AdapterDataBoundary {
  processing: "local" | "cloud" | "unknown";
  destinations: string[];
}

export interface HarnessAdapter {
  id: string;
  apiVersion: 1;
  dataBoundary: AdapterDataBoundary;
  capabilities: AdapterCapabilities;
  /** 不支持自动发现时返回显式配置的会话列表；空列表不代表接入已就绪。 */
  discover(ctx: CallContext): Promise<HarnessSession[]>;
  /** 成功返回即上游订阅已就绪；注销函数/源断线结束订阅。 */
  subscribe(cb: (event: HarnessEvent) => void, ctx: CallContext): Promise<() => void>;
  submit?(req: TaskRequest, ctx: CallContext): Promise<TaskRef>;
  query?(key: { brokerRequestId: string }, ctx: CallContext): Promise<TaskQueryResult>;
  reply?(ref: TaskRef, input: { inputId: string; text: string }, ctx: CallContext): Promise<void>;
  cancel?(ref: TaskRef, ctx: CallContext): Promise<void>;
  decidePermission?(decision: PermissionDecision, ctx: CallContext): Promise<OperationSnapshot>;
  queryOperation?(key: { operationId: string }, ctx: CallContext): Promise<OperationQueryResult>;
  listSessions?(query: { limit?: number }, ctx: CallContext): Promise<SessionOverviewItem[]>;
}

export interface SessionOverviewItem {
  sessionId: string;
  workdir: string;
  lastActiveAt: string;
  state: "busy" | "idle" | "waiting_input" | "waiting_permission" | "unknown";
  title?: string;
}

/** 适配器声明能力与实现的一致性校验（注册时调用；§5.1）。 */
export function checkCapabilityConsistency(adapter: HarnessAdapter): string[] {
  const problems: string[] = [];
  const requires = (capability: boolean, methodName: keyof HarnessAdapter, capabilityName: string): void => {
    if (capability && typeof adapter[methodName] !== "function") {
      problems.push(`capability ${capabilityName} requires method ${String(methodName)}`);
    }
  };
  requires(adapter.capabilities.newTask, "submit", "newTask");
  requires(adapter.capabilities.cancel, "cancel", "cancel");
  requires(adapter.capabilities.reply, "reply", "reply");
  requires(adapter.capabilities.sessionOverview, "listSessions", "sessionOverview");
  if (adapter.capabilities.query !== "none" && typeof adapter.query !== "function") {
    problems.push(`capability query=${adapter.capabilities.query} requires method query`);
  }
  if (adapter.capabilities.approval === "bridge") {
    if (typeof adapter.decidePermission !== "function") {
      problems.push("capability approval=bridge requires method decidePermission");
    }
    if (typeof adapter.queryOperation !== "function") {
      problems.push("capability approval=bridge requires method queryOperation");
    }
  }
  if (adapter.capabilities.approval !== "none" && !adapter.capabilities.newTask) {
    problems.push("approval native/bridge is only meaningful with newTask dispatch");
  }
  if (!adapter.capabilities.events && !adapter.capabilities.newTask) {
    problems.push("adapter declares neither events nor newTask: nothing to integrate");
  }
  return problems;
}
