/**
 * dsh 观察适配器 v0（票据 #46 系列之外，M2b 前置）：
 * 依据 2026-10-31 活体 spike（dsh 0.2.1-rc.5）的保守能力声明。
 *
 * 审批现状：headless 模式下危险操作 fail-closed（沙箱拒绝 + 升级需审批通道，
 * 无通道即拒）——没有用户可确认的原生 UI 通道，因此本适配器声明
 * approval: "none"，按 §5.1 只允许观察/表达；newTask 派发在审批故事
 * （web UI 通道或 permission hook 桥）按 M2b 决策启用前保持关闭。
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
} from "@maneki-pet/core";

export interface DshAdapterOptions {
  /** 显式配置的观察会话列表（discover 返回它；空数组不代表接入就绪）。 */
  sessions?: HarnessSession[];
  adapterId?: string;
}

export class DshAdapter implements HarnessAdapter {
  readonly id: string;
  readonly apiVersion = 1 as const;
  readonly dataBoundary: AdapterDataBoundary = {
    processing: "cloud",
    destinations: ["api.deepseek.com"],
  };
  readonly capabilities: AdapterCapabilities = {
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

  constructor(private readonly options: DshAdapterOptions = {}) {
    this.id = options.adapterId ?? "dsh";
    const problems = checkCapabilityConsistency(this);
    if (problems.length > 0) {
      throw new Error(`dsh adapter capability inconsistency: ${problems.join("; ")}`);
    }
  }

  async discover(_ctx: CallContext): Promise<HarnessSession[]> {
    return this.options.sessions ?? [];
  }

  /**
   * headless 模式没有外部事件源：受控任务的 ndjson 事件在派发启用后
   * 由任务运行器逐流提供；此处先登记回调并返回注销函数。
   */
  async subscribe(
    _cb: (event: HarnessEvent) => void,
    _ctx: CallContext,
  ): Promise<() => void> {
    return () => undefined;
  }
}
