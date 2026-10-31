/**
 * Core Task Broker（architecture §5.3 v1 子集）：入口幂等键映射、
 * 同项目串行 + 有界排队、取消与查询。持久化经 TaskBrokerStore 端口
 * （Runtime 以 SQLite 实现）；完成驱动由 Runtime 轮询/事件注入
 * `notifySettled`，Broker 自身不做 IO、不做模型调用。
 */
import type { TaskStatus } from "./harness-adapter.js";

export interface BrokerTask {
  brokerRequestId: string;
  clientRequestId: string;
  /** 入口请求快照：同键异内容冲突判定与审计依据（不可变）。 */
  prompt: string;
  workdir: string;
  status: TaskStatus;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskBrokerStore {
  getTask(brokerRequestId: string): BrokerTask | undefined;
  putTask(task: BrokerTask): void;
  allTasks(): BrokerTask[];
}

export class InMemoryTaskStore implements TaskBrokerStore {
  private readonly tasks = new Map<string, BrokerTask>();

  getTask(brokerRequestId: string): BrokerTask | undefined {
    return this.tasks.get(brokerRequestId);
  }

  putTask(task: BrokerTask): void {
    this.tasks.set(task.brokerRequestId, { ...task });
  }

  allTasks(): BrokerTask[] {
    return [...this.tasks.values()];
  }
}

export interface TaskBrokerConfig {
  /** 同一 workdir 允许的运行中任务上限（默认 1 = 串行）。 */
  maxRunningPerWorkdir: number;
  /** 同一 workdir 的排队上限；队列满时派发被拒绝（有界，不静默丢弃）。 */
  maxQueuedPerWorkdir: number;
}

export const defaultTaskBrokerConfig: TaskBrokerConfig = {
  maxRunningPerWorkdir: 1,
  maxQueuedPerWorkdir: 4,
};

export type SubmitDecision =
  | { outcome: "accepted"; task: BrokerTask }
  | { outcome: "idempotent-replay"; task: BrokerTask }
  | { outcome: "rejected"; reason: string };

export interface Dispatcher {
  /** 派发新任务到 harness；调用方保证 workdir 串行约束已满足。 */
  dispatch(task: BrokerTask): Promise<void>;
}

export class TaskBroker {
  private readonly config: TaskBrokerConfig;

  constructor(
    private readonly deps: {
      store: TaskBrokerStore;
      clock: () => Date;
      dispatcher: Dispatcher;
      config?: Partial<TaskBrokerConfig>;
    },
  ) {
    this.config = { ...defaultTaskBrokerConfig, ...deps.config };
  }

  /** 入口幂等：同 clientRequestId 同内容 → 原回执；异内容 → 冲突拒绝。 */
  submit(entry: { clientRequestId: string; prompt: string; workdir: string; sessionId?: string }): SubmitDecision {
    const existing = this.deps.store.allTasks().find((task) => task.clientRequestId === entry.clientRequestId);
    if (existing) {
      if (existing.prompt === entry.prompt && existing.workdir === entry.workdir) {
        return { outcome: "idempotent-replay", task: existing };
      }
      return { outcome: "rejected", reason: `clientRequestId "${entry.clientRequestId}" replayed with different content (入口幂等键冲突)` };
    }

    const running = this.workdirTasks(entry.workdir).filter(
      (task) => task.status === "running" || task.status === "queued",
    );
    const runningCount = running.filter((task) => task.status === "running").length;
    const queuedCount = running.length - runningCount;

    const now = this.deps.clock().toISOString();
    const brokerRequestId = `br-${entry.clientRequestId}`;
    if (this.deps.store.getTask(brokerRequestId)) {
      return { outcome: "rejected", reason: `brokerRequestId "${brokerRequestId}" already exists（同键异入口冲突）` };
    }
    const task: BrokerTask = {
      brokerRequestId,
      clientRequestId: entry.clientRequestId,
      prompt: entry.prompt,
      workdir: entry.workdir,
      sessionId: entry.sessionId ?? "",
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };

    if (runningCount < this.config.maxRunningPerWorkdir) {
      task.status = "running";
      this.deps.store.putTask(task);
      void this.deps.dispatcher.dispatch(task).catch(() => {
        // 派发异常不回滚状态：任务标记 failed 由调用方经 failTask 显式登记。
        this.failTask(brokerRequestId, "dispatch failed");
      });
      return { outcome: "accepted", task };
    }
    if (queuedCount >= this.config.maxQueuedPerWorkdir) {
      return { outcome: "rejected", reason: `queue full for workdir: ${queuedCount} queued (max ${this.config.maxQueuedPerWorkdir})` };
    }
    this.deps.store.putTask(task);
    return { outcome: "accepted", task };
  }

  /** 运行任务完成/失败后由 Runtime 调用：队列前移并自动派发下一单。 */
  notifySettled(brokerRequestId: string, status: Extract<TaskStatus, "completed" | "failed" | "cancelled">): BrokerTask | undefined {
    const task = this.deps.store.getTask(brokerRequestId);
    if (!task || task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
      return task;
    }
    task.status = status;
    task.updatedAt = this.deps.clock().toISOString();
    this.deps.store.putTask(task);
    this.dispatchNextQueued(task.workdir);
    return task;
  }

  private dispatchNextQueued(workdir: string): void {
    const queued = this.workdirTasks(workdir)
      .filter((task) => task.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const runningCount = this.workdirTasks(workdir).filter((task) => task.status === "running").length;
    const next = queued[0];
    if (!next || runningCount >= this.config.maxRunningPerWorkdir) {
      return;
    }
    next.status = "running";
    next.updatedAt = this.deps.clock().toISOString();
    this.deps.store.putTask(next);
    void this.deps.dispatcher.dispatch(next).catch(() => {
      this.failTask(next.brokerRequestId, "dispatch failed");
    });
  }

  private failTask(brokerRequestId: string, reason: string): void {
    const task = this.deps.store.getTask(brokerRequestId);
    if (!task) return;
    task.status = "failed";
    task.updatedAt = this.deps.clock().toISOString();
    this.deps.store.putTask(task);
    this.dispatchNextQueued(task.workdir);
    void reason;
  }

  /** 已登记任务数量（按 workdir），供队列边界与展示。 */
  workdirTasks(workdir: string): BrokerTask[] {
    return this.deps.store
      .allTasks()
      .filter((task) => task.workdir === workdir && (task.status === "running" || task.status === "queued"));
  }
}
