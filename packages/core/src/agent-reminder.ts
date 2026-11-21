export const AGENT_REMINDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
export const MAX_AGENT_REMINDER_DELAY_SECONDS = 366 * 24 * 60 * 60;
export const MAX_AGENT_REMINDER_MESSAGE_LENGTH = 512;
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

/** 将用户的一次提醒意图规范化，供客户端和受理写入的 Runtime 共同校验。 */
export function normalizeAgentReminder(input: unknown): AgentReminderInput | null {
  if (typeof input !== "object" || !input || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== 3 || !keys.includes("requestId") || !keys.includes("afterSeconds") || !keys.includes("message")) return null;
  const { requestId, afterSeconds, message } = input as Record<string, unknown>;
  if (typeof requestId !== "string" || !AGENT_REMINDER_ID_PATTERN.test(requestId) ||
      typeof afterSeconds !== "number" || !Number.isInteger(afterSeconds) ||
      afterSeconds < 1 || afterSeconds > MAX_AGENT_REMINDER_DELAY_SECONDS || typeof message !== "string") return null;
  const text = message.trim();
  if (text.length === 0 || text.length > MAX_AGENT_REMINDER_MESSAGE_LENGTH || invalidReminderCharacter.test(text)) return null;
  return { requestId, afterSeconds, message: text };
}
