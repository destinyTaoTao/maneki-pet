import { normalizeAgentReminder, type AgentReminderInput, type AgentReminderReceipt } from "@maneki-pet/core";
import { createPairedTransport, ReminderClientError, type PairedClientOptions } from "./paired-transport.js";

export type ReminderClientOptions = PairedClientOptions;

export function createReminderClient(options: ReminderClientOptions) {
  const exchange = createPairedTransport("reminder", options);
  return {
    /** 仅用于用户明确要求的提醒。同一意图重试时须保留原 requestId、延时和内容。 */
    async createReminder(input: AgentReminderInput, signal?: AbortSignal): Promise<AgentReminderReceipt> {
      const normalized = normalizeAgentReminder(input);
      if (!normalized) throw new ReminderClientError("无效的提醒参数");
      const body = await exchange(signal, JSON.stringify(normalized));
      const { requestId, reminderId, remindAt } = body;
      if (Object.keys(body).length !== 3 || requestId !== normalized.requestId ||
          typeof reminderId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reminderId) ||
          typeof remindAt !== "number" || !Number.isSafeInteger(remindAt) || remindAt < 0 || !Number.isFinite(new Date(remindAt).getTime())) {
        throw new ReminderClientError("Runtime 提醒回执格式无效");
      }
      return { requestId, reminderId, remindAt };
    },
  };
}
