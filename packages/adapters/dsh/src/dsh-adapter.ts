/** dsh Adapter：宿主审批、恢复与事件订阅尚未通过验收，保持未就绪。 */
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
  readonly capabilities: AdapterCapabilities = { ...UNAVAILABLE_CAPABILITIES };

  constructor(private readonly options: DshAdapterOptions = {}) {
    this.id = options.adapterId ?? "dsh";
    const problems = checkCapabilityConsistency(this);
    if (problems.length) throw new Error(`dsh adapter capability inconsistency: ${problems.join("; ")}`);
  }

  async discover(_ctx: CallContext): Promise<HarnessSession[]> {
    return this.options.sessions ?? [];
  }

  async subscribe(_cb: (event: HarnessEvent) => void, _ctx: CallContext): Promise<() => void> {
    throw unsupported();
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
