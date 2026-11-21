export const AGENT_REMINDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
export const AGENT_REMINDER_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_AGENT_REMINDER_DELAY_SECONDS = 366 * 24 * 60 * 60;
export const MAX_AGENT_REMINDER_MESSAGE_LENGTH = 512;
export const MAX_AGENT_REMINDER_LIST_ITEMS = 200;
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
      !validReminderDelay(afterSeconds) || typeof message !== "string") return null;
  const text = message.trim();
  if (text.length === 0 || text.length > MAX_AGENT_REMINDER_MESSAGE_LENGTH || invalidReminderCharacter.test(text)) return null;
  return { requestId, afterSeconds, message: text };
}
