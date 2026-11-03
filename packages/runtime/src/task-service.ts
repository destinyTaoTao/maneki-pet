/**
 * 任务服务（M2b）：Core Task Broker + dsh 网关适配器的装配胶水。
 * Broker 由 Runtime 装配；审批和恢复未验证期间只提供已有记录的查询，
 * 新派发与无法确认停止的取消保持关闭。
 */
import { TaskBroker, type BrokerTask } from "@maneki-pet/core";

export class TaskService {
  constructor(private readonly broker: TaskBroker) {}

  /** 审批与恢复验收前拒绝新派发；既有请求结果需先核查。 */
  async submit(entry: { clientRequestId: string; prompt: string; workdir: string }): Promise<{ outcome: string; task?: BrokerTask; reason?: string }> {
    void entry;
    // #3：真实审批与完整恢复尚未通过验收，网关配置不能作为执行授权。
    return { outcome: "rejected", reason: "dsh approval and full recovery are not verified; previous requests may have run, inspect existing tasks before retrying" };
  }

  /** 本地记录保留原值；无可靠外部查询时向调用方报告未知。 */
  async describe(brokerRequestId: string, clientId: string): Promise<BrokerTask & { gatewaySnapshot?: Record<string, unknown> }> {
    const task = this.ownedTask(brokerRequestId, clientId);
    return { ...task, status: "unknown", gatewaySnapshot: { outcome: "unknown", reason: "tracking unavailable; inspect the harness directly" } };
  }

  async cancel(brokerRequestId: string, clientId: string): Promise<BrokerTask> {
    this.ownedTask(brokerRequestId, clientId);
    // 取消受理并不证明任务停止，也不能因此推进旧队列（#13）。
    throw Object.assign(new Error("task cancellation is not verified; inspect the harness directly"), { code: "unavailable" });
  }

  private ownedTask(brokerRequestId: string, clientId: string): BrokerTask {
    const task = this.broker.describeTask(brokerRequestId);
    if (!task?.clientId || task.clientId !== clientId) {
      throw Object.assign(new Error("task not found"), { code: "not_found" });
    }
    return task;
  }
}
