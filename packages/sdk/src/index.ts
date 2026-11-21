import { randomUUID } from "node:crypto";
import { expressionStates, petStates, type PetState } from "@maneki-pet/core";
import { createPairedTransport, ExpressionClientError, type PairedClientOptions } from "./paired-transport.js";

export { createBriefingClient, type BriefingClientOptions } from "./briefing.js";
export {
  createRecurringReminderClient, createRecurringReminderRescheduleClient, createReminderCancelClient, createReminderClient,
  createReminderReadClient, createReminderRescheduleClient, type RecurringReminderClientOptions,
  type RecurringReminderRescheduleClientOptions, type ReminderClientOptions,
} from "./reminder.js";
export type {
  AgentReminderCancelInput, AgentReminderCancelReceipt, AgentReminderInput, AgentReminderList, AgentReminderReceipt,
  AgentReminderRescheduleInput, AgentReminderRescheduleReceipt, AgentReminderSummary,
  DailyReminderCancelInput, DailyReminderCancelReceipt, DailyReminderInput, DailyReminderList, DailyReminderReceipt,
  DailyReminderRescheduleInput, DailyReminderRescheduleReceipt, DailyReminderRescheduleTarget,
  DailyReminderRescheduleTargetList, DailyReminderSummary, WorkBriefing,
} from "@maneki-pet/core";
export { BriefingClientError, ExpressionClientError, ReminderClientError } from "./paired-transport.js";
export { expressionStates };
export type ExpressionState = typeof expressionStates[number];

export interface ExpressionClientOptions extends PairedClientOptions {
  /** 进程间需要更新同一租约时显式提供。 */
  sourceId?: string;
}

export function isExpressionState(value: unknown): value is ExpressionState {
  return expressionStates.some((state) => state === value);
}

/** 独立来源按 Runtime 的短租约规则参与仲裁。 */
export function createExpressionClient(options: ExpressionClientOptions) {
  const sourceId = options.sourceId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sourceId)) {
    throw new ExpressionClientError("sourceId 必须为小写 UUID");
  }
  const exchange = createPairedTransport("expression", options);
  async function readState(signal?: AbortSignal, payload?: string): Promise<PetState> {
    const body = await exchange(signal, payload);
    const current = petStates.find((entry) => entry === body.state);
    if (!current) throw new ExpressionClientError("Runtime 状态响应格式无效");
    return current;
  }
  return {
    sourceId,
    getState: (signal?: AbortSignal) => readState(signal),
    async setState(state: ExpressionState, signal?: AbortSignal): Promise<PetState> {
      if (!isExpressionState(state)) throw new ExpressionClientError("无效的表达状态");
      return readState(signal, JSON.stringify({ sourceId, state }));
    },
  };
}
