import {
  AGENT_REMINDER_UUID_PATTERN, DAILY_REMINDER_TIME_PATTERN, MAX_AGENT_REMINDER_LIST_ITEMS,
  MAX_AGENT_REMINDER_MESSAGE_LENGTH, MAX_DAILY_REMINDERS_PER_CLIENT,
  normalizeAgentReminder, normalizeAgentReminderCancelInput, normalizeAgentReminderMessage, normalizeAgentReminderRescheduleInput,
  normalizeDailyReminderCancelInput, normalizeDailyReminderInput, validTimeZone,
  type AgentReminderCancelInput, type AgentReminderCancelReceipt, type AgentReminderInput, type AgentReminderList,
  type AgentReminderReceipt, type AgentReminderRescheduleInput, type AgentReminderRescheduleReceipt,
  type AgentReminderSummary, type DailyReminderCancelInput, type DailyReminderCancelReceipt, type DailyReminderInput,
  type DailyReminderList, type DailyReminderReceipt, type DailyReminderSummary,
} from "@maneki-pet/core";
import { createPairedTransport, ReminderClientError, type PairedClientOptions } from "./paired-transport.js";

export type ReminderClientOptions = PairedClientOptions;
export type RecurringReminderClientOptions = PairedClientOptions;

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

function validDailyReminderFields(row: Record<string, unknown>): row is Record<string, unknown> & Omit<DailyReminderReceipt, "requestId"> {
  const { seriesId, localTime, timeZone, nextAt } = row;
  return typeof seriesId === "string" && AGENT_REMINDER_UUID_PATTERN.test(seriesId) &&
    typeof localTime === "string" && DAILY_REMINDER_TIME_PATTERN.test(localTime) &&
    typeof timeZone === "string" && validTimeZone(timeZone) && validRemindAt(nextAt);
}

function validDailySummary(row: unknown): row is DailyReminderSummary {
  if (typeof row !== "object" || !row || Array.isArray(row) || Object.keys(row).length !== 5) return false;
  const fields = row as Record<string, unknown>;
  return validDailyReminderFields(fields) && typeof fields.message === "string" &&
    normalizeAgentReminderMessage(fields.message) === fields.message;
}

function validDailySummaries(rows: unknown): rows is DailyReminderSummary[] {
  if (!Array.isArray(rows) || rows.length > MAX_DAILY_REMINDERS_PER_CLIENT) return false;
  const ids = new Set<string>();
  let previous: DailyReminderSummary | undefined;
  for (const row of rows) {
    if (!validDailySummary(row) || ids.has(row.seriesId)) return false;
    if (previous && (row.nextAt < previous.nextAt ||
      (row.nextAt === previous.nextAt && row.seriesId < previous.seriesId))) return false;
    ids.add(row.seriesId);
    previous = row;
  }
  return true;
}

export function createRecurringReminderClient(options: RecurringReminderClientOptions) {
  const create = createPairedTransport("recurring-reminder-create", options);
  const list = createPairedTransport("recurring-reminder-list", options);
  const cancel = createPairedTransport("recurring-reminder-cancel", options);
  return {
    /** 用户明确要求每日提醒时调用，同一意图重试时保留原参数。 */
    async createDailyReminder(input: DailyReminderInput, signal?: AbortSignal): Promise<DailyReminderReceipt> {
      const normalized = normalizeDailyReminderInput(input);
      if (!normalized) throw new ReminderClientError("无效的每日提醒参数");
      const body = await create(signal, JSON.stringify(normalized));
      if (Object.keys(body).length !== 5 || body.requestId !== normalized.requestId ||
          !validDailyReminderFields(body) || body.localTime !== normalized.localTime) {
        throw new ReminderClientError("Runtime 每日提醒回执格式无效");
      }
      const { requestId, seriesId, localTime, timeZone, nextAt } = body;
      return { requestId, seriesId, localTime, timeZone, nextAt };
    },
    async listDailyReminders(signal?: AbortSignal): Promise<DailyReminderList> {
      const body = await list(signal);
      if (Object.keys(body).length !== 1 || !validDailySummaries(body.reminders)) {
        throw new ReminderClientError("Runtime 每日提醒列表格式无效");
      }
      return { reminders: body.reminders };
    },
    /** 使用已明确选定规则的完整 ID，同一意图重试时保留原参数。 */
    async cancelDailyReminder(input: DailyReminderCancelInput, signal?: AbortSignal): Promise<DailyReminderCancelReceipt> {
      const normalized = normalizeDailyReminderCancelInput(input);
      if (!normalized) throw new ReminderClientError("无效的取消每日提醒参数");
      const body = await cancel(signal, JSON.stringify(normalized));
      const { requestId, seriesId, cancelled } = body;
      if (Object.keys(body).length !== 3 || requestId !== normalized.requestId ||
          seriesId !== normalized.seriesId || cancelled !== true) {
        throw new ReminderClientError("Runtime 取消每日提醒回执格式无效");
      }
      return { requestId, seriesId, cancelled };
    },
  };
}
