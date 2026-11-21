import { createHash, randomUUID } from "node:crypto";
import {
  AGENT_REMINDER_ID_PATTERN,
  AGENT_REMINDER_UUID_PATTERN,
  MAX_DAILY_REMINDERS,
  MAX_DAILY_REMINDERS_PER_CLIENT,
  localParts,
  localTimeToUtc,
  normalizeDailyReminderCancelInput,
  normalizeDailyReminderInput,
  validDateOnly,
  validTimeZone,
  type DailyReminderCancelReceipt,
  type DailyReminderList,
  type DailyReminderReceipt,
  type DailyReminderSummary,
} from "@maneki-pet/core";
import { AssistantError, readAssistantSettings } from "./assistant-settings.js";
import type { AssistantStore } from "./assistant-store.js";

const STATE_KEY = "dailyReminders.v1";
const MAX_STATE_LENGTH = 100_000;
const DAY_MS = 86_400_000;

interface Occurrence {
  nextDate: string;
  nextAt: number;
}
interface StoredRule extends Omit<DailyReminderSummary, "nextAt"> {
  clientId: string;
  nextDate: string;
}
interface Rule extends StoredRule {
  occurrence: Occurrence;
}
interface State {
  version: 1;
  rules: StoredRule[];
}
type Schedule = Pick<StoredRule, "timeZone" | "localTime">;
interface Delivery {
  id: string;
  message: string;
  timeZone: string;
  remindAt: number;
}

const unavailable = () => new AssistantError(503, "daily_reminder_storage_unavailable");
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const nextDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

function nextOccurrence(schedule: Schedule, date: string, after = -Infinity): Occurrence {
  // 连续多日无合法本地时间表示时钟或时区数据异常。限制同步查找的工作量。
  for (let attempt = 0; attempt < 7 && validDateOnly(date); attempt++, date = nextDate(date)) {
    const time = localTimeToUtc(`${date}T${schedule.localTime}`, schedule.timeZone);
    if (time !== null && time > after) return { nextDate: date, nextAt: time };
  }
  throw unavailable();
}

function compareOccurrences(a: Rule, b: Rule): number {
  return a.occurrence.nextAt - b.occurrence.nextAt || a.seriesId.localeCompare(b.seriesId);
}

function summary(rule: Rule): DailyReminderSummary {
  const { seriesId, localTime, message, timeZone, occurrence } = rule;
  return { seriesId, localTime, message, timeZone, nextAt: occurrence.nextAt };
}

function moveRule(rule: Rule, occurrence: Occurrence): Rule {
  return { ...rule, nextDate: occurrence.nextDate, occurrence };
}

function currentOccurrence(rule: Rule, now: number, days: Map<string, string>): Rule {
  if (rule.occurrence.nextAt > now) return rule;
  let today = days.get(rule.timeZone);
  if (today === undefined) {
    today = localParts(now, rule.timeZone).date;
    days.set(rule.timeZone, today);
  }
  if (rule.nextDate >= today) return rule;
  const occurrence = rule.occurrence.nextDate === today ? rule.occurrence : nextOccurrence(rule, today);
  return moveRule(rule, occurrence);
}

function isValidEpoch(nextAt: unknown): nextAt is number {
  return typeof nextAt === "number" && Number.isSafeInteger(nextAt) &&
    nextAt > 0 && Number.isFinite(new Date(nextAt).getTime());
}

function isStoredRule(value: unknown): value is StoredRule {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 6) return false;
  const rule = value as Partial<StoredRule>;
  const normalized = normalizeDailyReminderInput({ requestId: "stored", localTime: rule.localTime, message: rule.message });
  return normalized !== null && normalized.message === rule.message &&
    typeof rule.clientId === "string" && AGENT_REMINDER_ID_PATTERN.test(rule.clientId) &&
    typeof rule.seriesId === "string" && AGENT_REMINDER_UUID_PATTERN.test(rule.seriesId) &&
    typeof rule.timeZone === "string" && validTimeZone(rule.timeZone) &&
    typeof rule.nextDate === "string" && validDateOnly(rule.nextDate);
}

export class DailyReminders {
  private parsed: { raw: string; rules: Rule[] } | undefined;

  constructor(private readonly store: AssistantStore, private readonly now: () => number) {}

  private read(): Rule[] {
    const raw = this.store.get(STATE_KEY);
    if (raw === null) return [];
    if (this.parsed?.raw === raw) return this.parsed.rules;
    if (typeof raw !== "string" || raw.length > MAX_STATE_LENGTH) throw unavailable();
    const ids = new Set<string>();
    const counts = new Map<string, number>();
    try {
      const state = JSON.parse(raw) as Partial<State> | null;
      if (state?.version !== 1 || !Array.isArray(state.rules) || state.rules.length > MAX_DAILY_REMINDERS) throw unavailable();
      const rules: Rule[] = [];
      for (const rule of state.rules) {
        if (!isStoredRule(rule) || ids.has(rule.seriesId)) throw unavailable();
        const count = (counts.get(rule.clientId) ?? 0) + 1;
        if (count > MAX_DAILY_REMINDERS_PER_CLIENT) throw unavailable();
        ids.add(rule.seriesId);
        counts.set(rule.clientId, count);
        rules.push({ ...rule, occurrence: nextOccurrence(rule, rule.nextDate) });
      }
      this.parsed = { raw, rules };
      return rules;
    } catch {
      throw unavailable();
    }
  }

  private save(rules: Rule[]): void {
    const stored = rules.map(({ occurrence: _occurrence, ...rule }) => rule);
    const raw = JSON.stringify({ version: 1, rules: stored } satisfies State);
    this.store.set(STATE_KEY, raw);
    // 后续读取仍比较 SQLite 原值，事务回滚时会重新读取已提交状态。
    this.parsed = { raw, rules };
  }

  create(clientId: string, raw: unknown): DailyReminderReceipt {
    const input = normalizeDailyReminderInput(raw);
    if (!input) throw new AssistantError(400, "daily_reminder_input_invalid");
    const { requestId, localTime, message } = input;
    const owner = `daily-reminder:${clientId}`;
    const hash = fingerprint(["create", localTime, message]);
    return this.store.transaction(() => {
      const rules = this.read();
      const cached = this.store.mutation(owner, requestId);
      if (cached) {
        if (cached.hash !== hash) throw new AssistantError(409, "request_id_conflict");
        try {
          const value = JSON.parse(cached.result) as Partial<DailyReminderReceipt>;
          if (value.requestId !== requestId || typeof value.seriesId !== "string" ||
              !AGENT_REMINDER_UUID_PATTERN.test(value.seriesId) || value.localTime !== localTime ||
              typeof value.timeZone !== "string" || !validTimeZone(value.timeZone) ||
              !isValidEpoch(value.nextAt)) throw unavailable();
          const { seriesId, timeZone, nextAt } = value;
          const receipt = { requestId, seriesId, localTime, timeZone, nextAt };
          if (cached.result !== JSON.stringify(receipt)) throw unavailable();
          return receipt;
        } catch {
          throw unavailable();
        }
      }
      if (rules.length >= MAX_DAILY_REMINDERS || rules.filter((rule) => rule.clientId === clientId).length >= MAX_DAILY_REMINDERS_PER_CLIENT) {
        throw new AssistantError(409, "daily_reminder_limit");
      }
      const now = this.now();
      const timeZone = readAssistantSettings(this.store).timeZone;
      const occurrence = nextOccurrence({ localTime, timeZone }, localParts(now, timeZone).date, now);
      const seriesId = randomUUID();
      const receipt = { requestId, seriesId, localTime, timeZone, nextAt: occurrence.nextAt };
      this.store.consumeAgentReminderQuota("daily_creation", clientId, now);
      this.save([...rules, { nextDate: occurrence.nextDate, occurrence, seriesId, clientId, localTime, message, timeZone }]);
      this.store.rememberMutation(owner, requestId, hash, receipt);
      return receipt;
    });
  }

  list(clientId: string): DailyReminderList {
    const now = this.now();
    const days = new Map<string, string>();
    return {
      reminders: this.read().filter((rule) => rule.clientId === clientId)
        .map((rule) => currentOccurrence(rule, now, days))
        .sort(compareOccurrences)
        .map(summary),
    };
  }

  cancel(clientId: string, raw: unknown): DailyReminderCancelReceipt {
    const input = normalizeDailyReminderCancelInput(raw);
    if (!input) throw new AssistantError(400, "daily_reminder_cancel_input_invalid");
    const { requestId, seriesId } = input;
    const owner = `daily-reminder:${clientId}`;
    const hash = fingerprint(["cancel", seriesId]);
    const receipt = { requestId, seriesId, cancelled: true } satisfies DailyReminderCancelReceipt;
    return this.store.transaction(() => {
      const rules = this.read();
      const cached = this.store.mutation(owner, requestId);
      if (cached) {
        if (cached.hash !== hash) throw new AssistantError(409, "request_id_conflict");
        if (cached.result !== JSON.stringify(receipt)) throw unavailable();
        return receipt;
      }
      const remaining = rules.filter((rule) => rule.seriesId !== seriesId || rule.clientId !== clientId);
      if (remaining.length === rules.length) throw new AssistantError(404, "daily_reminder_not_found");
      this.save(remaining);
      this.store.rememberMutation(owner, requestId, hash, receipt);
      return receipt;
    });
  }

  nextDue(): number | null {
    const rules = this.read();
    return rules.length ? Math.min(...rules.map((rule) => rule.occurrence.nextAt)) : null;
  }

  advance(now: number, allowed: boolean): Delivery | null {
    const next = this.nextDue();
    if (next === null || next > now) return null;
    return this.store.transaction(() => {
      const rules = this.read();
      const days = new Map<string, string>();
      const current = rules.map((rule) => currentOccurrence(rule, now, days));
      let due: Rule | undefined;
      if (allowed) {
        for (const rule of current) {
          if (rule.occurrence.nextAt <= now && (!due || compareOccurrences(rule, due) < 0)) due = rule;
        }
      }
      if (!due) {
        if (current.some((rule, index) => rule !== rules[index])) this.save(current);
        return null;
      }
      // 认领提交后该日期不再可调度，即使通知器失败或进程退出。
      const { nextDate: deliveryDate, nextAt } = due.occurrence;
      const following = nextOccurrence(due, nextDate(deliveryDate));
      this.save(current.map((rule) => rule === due ? moveRule(rule, following) : rule));
      return {
        id: `${due.seriesId}:${deliveryDate}`,
        message: due.message,
        timeZone: due.timeZone,
        remindAt: nextAt,
      };
    });
  }
}
