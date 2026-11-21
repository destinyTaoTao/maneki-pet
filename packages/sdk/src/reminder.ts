import {
  AGENT_REMINDER_UUID_PATTERN, MAX_AGENT_REMINDER_LIST_ITEMS, MAX_AGENT_REMINDER_MESSAGE_LENGTH,
  normalizeAgentReminder, normalizeAgentReminderCancelInput, normalizeAgentReminderRescheduleInput,
  type AgentReminderCancelInput, type AgentReminderCancelReceipt, type AgentReminderInput, type AgentReminderList,
  type AgentReminderReceipt, type AgentReminderRescheduleInput, type AgentReminderRescheduleReceipt,
  type AgentReminderSummary,
} from "@maneki-pet/core";
import { createPairedTransport, ReminderClientError, type PairedClientOptions } from "./paired-transport.js";

export type ReminderClientOptions = PairedClientOptions;

function validRemindAt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime());
}

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
          !validRemindAt(remindAt)) {
        throw new ReminderClientError("Runtime 提醒回执格式无效");
      }
      return { requestId, reminderId, remindAt };
    },
  };
}

function validSummary(row: unknown): row is AgentReminderSummary {
  if (typeof row !== "object" || !row || Array.isArray(row) || Object.keys(row).length !== 4) return false;
  const { reminderId, message, remindAt, version } = row as Record<string, unknown>;
  return typeof reminderId === "string" && AGENT_REMINDER_UUID_PATTERN.test(reminderId) &&
    typeof message === "string" && message.trim().length > 0 && message.length <= MAX_AGENT_REMINDER_MESSAGE_LENGTH &&
    validRemindAt(remindAt) && typeof version === "number" && Number.isSafeInteger(version) && version >= 1;
}

function validSummaries(rows: unknown): rows is AgentReminderSummary[] {
  if (!Array.isArray(rows) || rows.length > MAX_AGENT_REMINDER_LIST_ITEMS) return false;
  const ids = new Set<string>();
  let previous: AgentReminderSummary | undefined;
  for (const row of rows) {
    if (!validSummary(row) || ids.has(row.reminderId)) return false;
    if (previous && (row.remindAt < previous.remindAt ||
      (row.remindAt === previous.remindAt && row.reminderId < previous.reminderId))) return false;
    ids.add(row.reminderId);
    previous = row;
  }
  return true;
}

export function createReminderReadClient(options: ReminderClientOptions) {
  const exchange = createPairedTransport("reminder-read", options);
  return {
    async listReminders(signal?: AbortSignal): Promise<AgentReminderList> {
      const body = await exchange(signal);
      if (Object.keys(body).length !== 1 || !validSummaries(body.reminders)) {
        throw new ReminderClientError("Runtime 待投递提醒列表格式无效");
      }
      return { reminders: body.reminders };
    },
  };
}

export function createReminderCancelClient(options: ReminderClientOptions) {
  const exchange = createPairedTransport("reminder-cancel", options);
  return {
    /** 使用已明确选定提醒的完整 ID 和查询所得版本，同一意图重试保留原参数。 */
    async cancelReminder(input: AgentReminderCancelInput, signal?: AbortSignal): Promise<AgentReminderCancelReceipt> {
      const normalized = normalizeAgentReminderCancelInput(input);
      if (!normalized) throw new ReminderClientError("无效的取消提醒参数");
      const body = await exchange(signal, JSON.stringify(normalized));
      const { requestId, reminderId, cancelled } = body;
      if (Object.keys(body).length !== 3 || requestId !== normalized.requestId ||
          reminderId !== normalized.reminderId || cancelled !== true) {
        throw new ReminderClientError("Runtime 取消提醒回执格式无效");
      }
      return { requestId, reminderId, cancelled };
    },
  };
}

export function createReminderRescheduleClient(options: ReminderClientOptions) {
  const exchange = createPairedTransport("reminder-reschedule", options);
  return {
    /** 使用已明确选定提醒的完整 ID 和查询所得版本，同一意图重试保留原 ID、版本和延时。 */
    async rescheduleReminder(input: AgentReminderRescheduleInput, signal?: AbortSignal): Promise<AgentReminderRescheduleReceipt> {
      const normalized = normalizeAgentReminderRescheduleInput(input);
      if (!normalized) throw new ReminderClientError("无效的提醒改期参数");
      const body = await exchange(signal, JSON.stringify(normalized));
      const { requestId, reminderId, remindAt, version } = body;
      if (Object.keys(body).length !== 4 || requestId !== normalized.requestId || reminderId !== normalized.reminderId ||
          !validRemindAt(remindAt) || typeof version !== "number" || !Number.isSafeInteger(version) || version !== normalized.version + 1) {
        throw new ReminderClientError("Runtime 提醒改期回执格式无效");
      }
      return { requestId, reminderId, remindAt, version };
    },
  };
}
