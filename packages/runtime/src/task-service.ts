/**
 * 任务服务（M2b）：Core Task Broker + dsh 网关适配器的装配胶水。
 * Broker 由 Runtime 装配（SQLite 持久化 + 配置限额）后注入；
 * 派发 = session/create + session/prompt（requestId = brokerRequestId，
 * dsh 原生幂等键与 Broker 对齐）；查询 = session/projections（asOfSeq）；
 * 取消 = session/cancel + Broker 状态登记。
 */
import { TaskBroker, type BrokerTask } from "@maneki-pet/core";

import { DshAdapter } from "@maneki-pet/adapter-dsh";

export class TaskService {
  constructor(
    private readonly broker: TaskBroker,
    private readonly adapter: DshAdapter,
  ) {}

  /** 派发入口（Runtime API 转发）：入口幂等 + 串行队列由 Broker 保证。 */
  async submit(entry: { clientRequestId: string; prompt: string; workdir: string }): Promise<{ outcome: string; task?: BrokerTask; reason?: string }> {
    void entry;
    // #3：真实审批与完整恢复尚未通过验收，网关配置不能作为执行授权。
    return { outcome: "rejected", reason: "dsh approval and full recovery are not verified" };
  }

  /** 查询：Broker 登记 + 适配器快照（dsh 网关可达时）。 */
  async describe(brokerRequestId: string): Promise<BrokerTask & { gatewaySnapshot?: Record<string, unknown> }> {
    const task = this.broker.describeTask(brokerRequestId);
    if (!task) {
      throw Object.assign(new Error(`task ${brokerRequestId} not found`), { code: "not_found" });
    }
    try {
      const snapshot = await this.adapter.query(
        { brokerRequestId },
        { requestId: brokerRequestId, signal: new AbortController().signal, deadlineAtMs: Date.now() + 10_000 },
      );
      return { ...task, gatewaySnapshot: snapshot as Record<string, unknown> };
    } catch {
      return { ...task };
    }
  }

  async cancel(brokerRequestId: string): Promise<BrokerTask> {
    void brokerRequestId;
    // 取消受理并不证明任务停止，也不能因此推进旧队列（#13）。
    throw Object.assign(new Error("task cancellation is not verified; inspect the harness directly"), { code: "unavailable" });
  }
}
