import {
  AGENT_REMINDER_UUID_PATTERN, DAILY_REMINDER_TIME_PATTERN, MAX_AGENT_REMINDER_LIST_ITEMS,
  MAX_AGENT_REMINDER_MESSAGE_LENGTH, MAX_DAILY_REMINDERS_PER_CLIENT, MAX_WEEKLY_REMINDERS_PER_CLIENT,
  normalizeAgentReminder, normalizeAgentReminderCancelInput, normalizeAgentReminderMessage, normalizeAgentReminderRescheduleInput,
  normalizeDailyReminderCancelInput, normalizeDailyReminderInput, normalizeDailyReminderRescheduleInput,
  normalizeWeeklyReminderDays, normalizeWeeklyReminderInput, validTimeZone,
  type AgentReminderCancelInput, type AgentReminderCancelReceipt, type AgentReminderInput, type AgentReminderList,
  type AgentReminderReceipt, type AgentReminderRescheduleInput, type AgentReminderRescheduleReceipt,
  type AgentReminderSummary, type DailyReminderCancelInput, type DailyReminderCancelReceipt, type DailyReminderInput,
  type DailyReminderList, type DailyReminderReceipt, type DailyReminderRescheduleInput, type DailyReminderRescheduleReceipt,
  type DailyReminderRescheduleTarget, type DailyReminderRescheduleTargetList, type DailyReminderSummary,
  type WeeklyReminderInput, type WeeklyReminderList, type WeeklyReminderReceipt, type WeeklyReminderRescheduleReceipt,
  type WeeklyReminderRescheduleTarget, type WeeklyReminderRescheduleTargetList, type WeeklyReminderSummary,
} from "@maneki-pet/core";
import { createPairedTransport, ReminderClientError, type PairedClientOptions } from "./paired-transport.js";

export type ReminderClientOptions = PairedClientOptions;
export type RecurringReminderClientOptions = PairedClientOptions;
export type RecurringReminderRescheduleClientOptions = PairedClientOptions;

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

function validDailySummaryFields(row: unknown): row is DailyReminderSummary {
  if (typeof row !== "object" || !row || Array.isArray(row)) return false;
  const fields = row as Record<string, unknown>;
  return validDailyReminderFields(fields) && typeof fields.message === "string" &&
    normalizeAgentReminderMessage(fields.message) === fields.message;
}

function validDailySummary(row: unknown): row is DailyReminderSummary {
  return validDailySummaryFields(row) && Object.keys(row).length === 5;
}

function matchesWeeklyDays(value: unknown, expected: readonly number[]): value is number[] {
  return Array.isArray(value) && value.length === expected.length && expected.every((day, index) => value[index] === day);
}

function validCanonicalWeeklyDays(value: unknown): value is number[] {
  const days = normalizeWeeklyReminderDays(value);
  return days !== null && matchesWeeklyDays(value, days);
}

function validWeeklySummaryFields(row: unknown): row is WeeklyReminderSummary {
  return validDailySummaryFields(row) && "daysOfWeek" in row && validCanonicalWeeklyDays(row.daysOfWeek);
}

function validWeeklySummary(row: unknown): row is WeeklyReminderSummary {
  return validWeeklySummaryFields(row) && Object.keys(row).length === 6;
}

function validRescheduleVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function validDailyRescheduleTarget(row: unknown): row is DailyReminderRescheduleTarget {
  return validDailySummaryFields(row) && Object.keys(row).length === 6 &&
    "version" in row && validRescheduleVersion(row.version);
}

function validWeeklyRescheduleTarget(row: unknown): row is WeeklyReminderRescheduleTarget {
  return validWeeklySummaryFields(row) && Object.keys(row).length === 7 &&
    "version" in row && validRescheduleVersion(row.version);
}

function validRescheduleReceiptFields(
  body: Record<string, unknown>, input: DailyReminderRescheduleInput,
): body is Record<string, unknown> & DailyReminderRescheduleReceipt {
  return body.requestId === input.requestId && validDailyReminderFields(body) &&
    body.seriesId === input.seriesId && body.localTime === input.localTime &&
    validRescheduleVersion(body.version) && body.version === input.version + 1;
}

function validRecurringRows<T extends DailyReminderSummary>(
  rows: unknown, validRow: (row: unknown) => row is T, limit = MAX_DAILY_REMINDERS_PER_CLIENT,
): rows is T[] {
  if (!Array.isArray(rows) || rows.length > limit) return false;
  const ids = new Set<string>();
  let previous: DailyReminderSummary | undefined;
  for (const row of rows) {
    if (!validRow(row) || ids.has(row.seriesId)) return false;
    if (previous && (row.nextAt < previous.nextAt ||
      (row.nextAt === previous.nextAt && row.seriesId < previous.seriesId))) return false;
    ids.add(row.seriesId);
    previous = row;
  }
  return true;
}

function recurringReminderCancelOperation(cancel: ReturnType<typeof createPairedTransport>, label: string) {
  return async (input: DailyReminderCancelInput, signal?: AbortSignal): Promise<DailyReminderCancelReceipt> => {
    const normalized = normalizeDailyReminderCancelInput(input);
    if (!normalized) throw new ReminderClientError(`无效的取消${label}参数`);
    const body = await cancel(signal, JSON.stringify(normalized));
    const { requestId, seriesId, cancelled } = body;
    if (Object.keys(body).length !== 3 || requestId !== normalized.requestId ||
        seriesId !== normalized.seriesId || cancelled !== true) {
      throw new ReminderClientError(`Runtime 取消${label}回执格式无效`);
    }
    return { requestId, seriesId, cancelled };
  };
}

function recurringReminderOperations(options: RecurringReminderClientOptions, recurrence: "daily" | "weekdays") {
  const endpoint = recurrence === "daily" ? "recurring-reminder" : "weekday-reminder";
  const label = recurrence === "daily" ? "每日提醒" : "工作日提醒";
  const create = createPairedTransport(`${endpoint}-create`, options);
  const list = createPairedTransport(`${endpoint}-list`, options);
  const cancel = createPairedTransport(`${endpoint}-cancel`, options);
  return {
    async createReminder(input: DailyReminderInput, signal?: AbortSignal): Promise<DailyReminderReceipt> {
      const normalized = normalizeDailyReminderInput(input);
      if (!normalized) throw new ReminderClientError(`无效的${label}参数`);
      const body = await create(signal, JSON.stringify(normalized));
      if (Object.keys(body).length !== 5 || body.requestId !== normalized.requestId ||
          !validDailyReminderFields(body) || body.localTime !== normalized.localTime) {
        throw new ReminderClientError(`Runtime ${label}回执格式无效`);
      }
      const { requestId, seriesId, localTime, timeZone, nextAt } = body;
      return { requestId, seriesId, localTime, timeZone, nextAt };
    },
    async listReminders(signal?: AbortSignal): Promise<DailyReminderList> {
      const body = await list(signal);
      if (Object.keys(body).length !== 1 || !validRecurringRows(body.reminders, validDailySummary)) {
        throw new ReminderClientError(`Runtime ${label}列表格式无效`);
      }
      return { reminders: body.reminders };
    },
    cancelReminder: recurringReminderCancelOperation(cancel, label),
  };
}

export function createRecurringReminderClient(options: RecurringReminderClientOptions) {
  const daily = recurringReminderOperations(options, "daily");
  const weekdays = recurringReminderOperations(options, "weekdays");
  const createWeekly = createPairedTransport("weekly-reminder-create", options);
  const listWeekly = createPairedTransport("weekly-reminder-list", options);
  const cancelWeekly = createPairedTransport("weekly-reminder-cancel", options);
  return {
    /** 用户明确要求每日提醒时调用，同一意图重试时保留原参数。 */
    createDailyReminder: daily.createReminder,
    listDailyReminders: daily.listReminders,
    /** 使用已明确选定规则的完整 ID，同一意图重试时保留原参数。 */
    cancelDailyReminder: daily.cancelReminder,
    /** 用户明确要求在规则时区内每周一至周五提醒时调用，同一意图重试时保留原参数。 */
    createWeekdayReminder: weekdays.createReminder,
    listWeekdayReminders: weekdays.listReminders,
    /** 使用已明确选定工作日规则的完整 ID，同一意图重试时保留原参数。 */
    cancelWeekdayReminder: weekdays.cancelReminder,
    /** 用户明确要求按指定星期提醒时调用，星期集合在发送前升序规范化。 */
    async createWeeklyReminder(input: WeeklyReminderInput, signal?: AbortSignal): Promise<WeeklyReminderReceipt> {
      const normalized = normalizeWeeklyReminderInput(input);
      if (!normalized) throw new ReminderClientError("无效的按星期提醒参数");
      const body = await createWeekly(signal, JSON.stringify(normalized));
      if (Object.keys(body).length !== 6 || body.requestId !== normalized.requestId ||
          !validDailyReminderFields(body) || body.localTime !== normalized.localTime ||
          !matchesWeeklyDays(body.daysOfWeek, normalized.daysOfWeek)) {
        throw new ReminderClientError("Runtime 按星期提醒回执格式无效");
      }
      const { requestId, seriesId, localTime, timeZone, nextAt, daysOfWeek } = body;
      return { requestId, seriesId, localTime, timeZone, nextAt, daysOfWeek };
    },
    async listWeeklyReminders(signal?: AbortSignal): Promise<WeeklyReminderList> {
      const body = await listWeekly(signal);
      if (Object.keys(body).length !== 1 || !validRecurringRows(body.reminders, validWeeklySummary, MAX_WEEKLY_REMINDERS_PER_CLIENT)) {
        throw new ReminderClientError("Runtime 按星期提醒列表格式无效");
      }
      return { reminders: body.reminders };
    },
    /** 使用已明确选定按星期规则的完整 ID，同一意图重试时保留原参数。 */
    cancelWeeklyReminder: recurringReminderCancelOperation(cancelWeekly, "按星期提醒"),
  };
}

function recurringReminderRescheduleOperations(options: RecurringReminderRescheduleClientOptions, recurrence: "daily" | "weekdays") {
  const endpoint = recurrence === "daily" ? "recurring-reminder-reschedule" : "weekday-reminder-reschedule";
  const label = recurrence === "daily" ? "每日提醒" : "工作日提醒";
  const list = createPairedTransport(`${endpoint}-targets`, options);
  const reschedule = createPairedTransport(endpoint, options);
  return {
    async listTargets(signal?: AbortSignal): Promise<DailyReminderRescheduleTargetList> {
      const body = await list(signal);
      if (Object.keys(body).length !== 1 || !validRecurringRows(body.reminders, validDailyRescheduleTarget)) {
        throw new ReminderClientError(`Runtime ${label}改期目标列表格式无效`);
      }
      return { reminders: body.reminders };
    },
    async rescheduleReminder(input: DailyReminderRescheduleInput, signal?: AbortSignal): Promise<DailyReminderRescheduleReceipt> {
      const normalized = normalizeDailyReminderRescheduleInput(input);
      if (!normalized) throw new ReminderClientError(`无效的${label}改期参数`);
      const body = await reschedule(signal, JSON.stringify(normalized));
      if (Object.keys(body).length !== 6 || !validRescheduleReceiptFields(body, normalized)) {
        throw new ReminderClientError(`Runtime ${label}改期回执格式无效`);
      }
      const { requestId, seriesId, localTime, timeZone, nextAt, version } = body;
      return { requestId, seriesId, localTime, timeZone, nextAt, version };
    },
  };
}

export function createRecurringReminderRescheduleClient(options: RecurringReminderRescheduleClientOptions) {
  const daily = recurringReminderRescheduleOperations(options, "daily");
  const weekdays = recurringReminderRescheduleOperations(options, "weekdays");
  const listWeekly = createPairedTransport("weekly-reminder-reschedule-targets", options);
  const rescheduleWeekly = createPairedTransport("weekly-reminder-reschedule", options);
  return {
    listTargets: daily.listTargets,
    /** 使用已明确选定每日规则的完整 ID 和查询所得版本，同一意图重试时保留原参数。 */
    rescheduleDailyReminder: daily.rescheduleReminder,
    listWeekdayTargets: weekdays.listTargets,
    /** 使用已明确选定工作日规则的完整 ID 和查询所得版本，同一意图重试时保留原参数。 */
    rescheduleWeekdayReminder: weekdays.rescheduleReminder,
    /** 结合星期集合定位规则，并取得改期所需的版本。 */
    async listWeeklyTargets(signal?: AbortSignal): Promise<WeeklyReminderRescheduleTargetList> {
      const body = await listWeekly(signal);
      if (Object.keys(body).length !== 1 ||
          !validRecurringRows(body.reminders, validWeeklyRescheduleTarget, MAX_WEEKLY_REMINDERS_PER_CLIENT)) {
        throw new ReminderClientError("Runtime 按星期提醒改期目标列表格式无效");
      }
      return { reminders: body.reminders };
    },
    /** 使用已明确选定按星期规则的完整 ID 和查询所得版本，同一意图重试时保留原参数。 */
    async rescheduleWeeklyReminder(input: DailyReminderRescheduleInput, signal?: AbortSignal): Promise<WeeklyReminderRescheduleReceipt> {
      const normalized = normalizeDailyReminderRescheduleInput(input);
      if (!normalized) throw new ReminderClientError("无效的按星期提醒改期参数");
      const body = await rescheduleWeekly(signal, JSON.stringify(normalized));
      if (Object.keys(body).length !== 7 || !validRescheduleReceiptFields(body, normalized) ||
          !validCanonicalWeeklyDays(body.daysOfWeek)) {
        throw new ReminderClientError("Runtime 按星期提醒改期回执格式无效");
      }
      const { requestId, seriesId, localTime, timeZone, nextAt, version, daysOfWeek } = body;
      return { requestId, seriesId, localTime, timeZone, nextAt, version, daysOfWeek };
    },
  };
}
