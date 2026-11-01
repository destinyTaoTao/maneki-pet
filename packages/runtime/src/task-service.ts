/**
 * 任务服务（M2b）：Core Task Broker + dsh 网关适配器的装配胶水。
 * Broker 由 Runtime 装配；审批和恢复未验证期间只提供已有记录的查询，
 * 新派发与无法确认停止的取消保持关闭。
 */
import { TaskBroker, type BrokerTask } from "@maneki-pet/core";

import { DshAdapter } from "@maneki-pet/adapter-dsh";

export class TaskService {
  constructor(
    private readonly broker: TaskBroker,
    private readonly adapter: DshAdapter,
  ) {}

  /** 审批与恢复验收前拒绝新派发；既有请求结果需先核查。 */
  async submit(entry: { clientRequestId: string; prompt: string; workdir: string }): Promise<{ outcome: string; task?: BrokerTask; reason?: string }> {
    void entry;
    // #3：真实审批与完整恢复尚未通过验收，网关配置不能作为执行授权。
    return { outcome: "rejected", reason: "dsh approval and full recovery are not verified; previous requests may have run, inspect existing tasks before retrying" };
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
