export const AGENT_REMINDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
export const AGENT_REMINDER_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_AGENT_REMINDER_DELAY_SECONDS = 366 * 24 * 60 * 60;
export const MAX_AGENT_REMINDER_MESSAGE_LENGTH = 512;
export const MAX_AGENT_REMINDER_LIST_ITEMS = 200;
export const DAILY_REMINDER_TIME_PATTERN = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
export const MAX_DAILY_REMINDERS_PER_CLIENT = 8;
export const MAX_DAILY_REMINDERS = 64;
export const MAX_WEEKLY_REMINDERS_PER_CLIENT = 8;
export const MAX_WEEKLY_REMINDERS = 64;
// Unicode 模式按码点匹配，完整的代理对仍可作为一个补充平面字符传递。
const invalidReminderCharacter = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u;

export interface AgentReminderInput {
  requestId: string;
  afterSeconds: number;
  message: string;
}

export interface AgentReminderReceipt {
  requestId: string;
  reminderId: string;
  remindAt: number;
}

export interface AgentReminderSummary {
  reminderId: string;
  message: string;
  remindAt: number;
  version: number;
}

export interface AgentReminderList {
  reminders: AgentReminderSummary[];
}

export interface AgentReminderCancelInput {
  requestId: string;
  reminderId: string;
  version: number;
}

export interface AgentReminderCancelReceipt {
  requestId: string;
  reminderId: string;
  cancelled: true;
}

export interface AgentReminderRescheduleInput extends AgentReminderCancelInput {
  afterSeconds: number;
}

export interface AgentReminderRescheduleReceipt extends AgentReminderReceipt {
  version: number;
}

export interface DailyReminderInput {
  requestId: string;
  localTime: string;
  message: string;
}

export interface DailyReminderReceipt {
  requestId: string;
  seriesId: string;
  localTime: string;
  timeZone: string;
  nextAt: number;
}

export interface DailyReminderSummary extends Omit<DailyReminderReceipt, "requestId"> {
  message: string;
}

export interface DailyReminderList {
  reminders: DailyReminderSummary[];
}

export interface WeeklyReminderInput extends DailyReminderInput {
  /** ISO 星期，1 为周一、7 为周日。 */
  daysOfWeek: readonly number[];
}

export interface WeeklyReminderReceipt extends DailyReminderReceipt {
  daysOfWeek: number[];
}

export interface WeeklyReminderSummary extends DailyReminderSummary {
  daysOfWeek: number[];
}

export interface WeeklyReminderList {
  reminders: WeeklyReminderSummary[];
}

export interface DailyReminderCancelInput {
  requestId: string;
  seriesId: string;
}

export interface DailyReminderCancelReceipt extends DailyReminderCancelInput {
  cancelled: true;
}

export interface DailyReminderRescheduleInput extends DailyReminderCancelInput {
  version: number;
  localTime: string;
}

export interface DailyReminderRescheduleReceipt extends DailyReminderReceipt {
  version: number;
}

export interface DailyReminderRescheduleTarget extends DailyReminderSummary {
  version: number;
}

export interface DailyReminderRescheduleTargetList {
  reminders: DailyReminderRescheduleTarget[];
}

function validReminderDelay(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_AGENT_REMINDER_DELAY_SECONDS;
}

/** 取消必需用户已消歧的完整 ID 和查询所得版本，禁止透传其他字段。 */
export function normalizeAgentReminderCancelInput(input: unknown): AgentReminderCancelInput | null {
  if (typeof input !== "object" || !input || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== 3 || !keys.includes("requestId") || !keys.includes("reminderId") || !keys.includes("version")) return null;
  const { requestId, reminderId, version } = input as Record<string, unknown>;
  if (typeof requestId !== "string" || !AGENT_REMINDER_ID_PATTERN.test(requestId) ||
      typeof reminderId !== "string" || !AGENT_REMINDER_UUID_PATTERN.test(reminderId) ||
      typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return null;
  return { requestId, reminderId, version };
}

/** 改期使用取消所需的精确定位字段，并校验新的相对延时。 */
export function normalizeAgentReminderRescheduleInput(input: unknown): AgentReminderRescheduleInput | null {
  if (typeof input !== "object" || !input || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== 4 || !keys.includes("afterSeconds")) return null;
  const { afterSeconds, ...target } = input as Record<string, unknown>;
  if (!validReminderDelay(afterSeconds)) return null;
  const normalized = normalizeAgentReminderCancelInput(target);
  return normalized ? { ...normalized, afterSeconds } : null;
}

/** 将用户的一次提醒意图规范化，供客户端和受理写入的 Runtime 共同校验。 */
export function normalizeAgentReminder(input: unknown): AgentReminderInput | null {
  if (typeof input !== "object" || !input || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== 3 || !keys.includes("requestId") || !keys.includes("afterSeconds") || !keys.includes("message")) return null;
  const { requestId, afterSeconds, message } = input as Record<string, unknown>;
  if (typeof requestId !== "string" || !AGENT_REMINDER_ID_PATTERN.test(requestId) ||
      !validReminderDelay(afterSeconds)) return null;
  const text = normalizeAgentReminderMessage(message);
  return text === null ? null : { requestId, afterSeconds, message: text };
}

export function normalizeAgentReminderMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const text = message.trim();
  if (text.length === 0 || text.length > MAX_AGENT_REMINDER_MESSAGE_LENGTH || invalidReminderCharacter.test(text)) return null;
  return text;
}

/** 每日规则只接受固定的本地时间，时区由 Runtime 在受理时确定。 */
export function normalizeDailyReminderInput(input: unknown): DailyReminderInput | null {
  if (typeof input !== "object" || !input || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== 3 || !keys.includes("requestId") || !keys.includes("localTime") || !keys.includes("message")) return null;
  const { requestId, localTime, message } = input as Record<string, unknown>;
  if (typeof requestId !== "string" || !AGENT_REMINDER_ID_PATTERN.test(requestId) ||
      typeof localTime !== "string" || !DAILY_REMINDER_TIME_PATTERN.test(localTime)) return null;
  const text = normalizeAgentReminderMessage(message);
  return text === null ? null : { requestId, localTime, message: text };
}

export function normalizeWeeklyReminderDays(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) return null;
  const days = new Set<number>();
  for (const day of value) {
    if (typeof day !== "number" || !Number.isInteger(day) || day < 1 || day > 7 || days.has(day)) return null;
    days.add(day);
  }
  return [...days].sort((left, right) => left - right);
}

/** 星期集合排序后参与持久幂等比较。 */
export function normalizeWeeklyReminderInput(input: unknown): WeeklyReminderInput | null {
  if (typeof input !== "object" || !input || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== 4 || !keys.includes("daysOfWeek")) return null;
  const { daysOfWeek, ...dailyFields } = input as Record<string, unknown>;
  const normalizedDays = normalizeWeeklyReminderDays(daysOfWeek);
  const daily = normalizeDailyReminderInput(dailyFields);
  return normalizedDays && daily ? { ...daily, daysOfWeek: normalizedDays } : null;
}

export function normalizeDailyReminderCancelInput(input: unknown): DailyReminderCancelInput | null {
  if (typeof input !== "object" || !input || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes("requestId") || !keys.includes("seriesId")) return null;
  const { requestId, seriesId } = input as Record<string, unknown>;
  if (typeof requestId !== "string" || !AGENT_REMINDER_ID_PATTERN.test(requestId) ||
      typeof seriesId !== "string" || !AGENT_REMINDER_UUID_PATTERN.test(seriesId)) return null;
  return { requestId, seriesId };
}

/** 根据完整规则 ID 和查询所得版本更新每日时刻。 */
export function normalizeDailyReminderRescheduleInput(input: unknown): DailyReminderRescheduleInput | null {
  if (typeof input !== "object" || !input || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== 4 || !keys.includes("version") || !keys.includes("localTime")) return null;
  const { version, localTime, ...target } = input as Record<string, unknown>;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1 ||
      typeof localTime !== "string" || !DAILY_REMINDER_TIME_PATTERN.test(localTime)) return null;
  const normalized = normalizeDailyReminderCancelInput(target);
  return normalized ? { ...normalized, version, localTime } : null;
}
