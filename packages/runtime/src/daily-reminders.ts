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
  normalizeDailyReminderRescheduleInput,
  validDateOnly,
  validTimeZone,
  type DailyReminderCancelReceipt,
  type DailyReminderList,
  type DailyReminderReceipt,
  type DailyReminderRescheduleReceipt,
  type DailyReminderRescheduleTargetList,
  type DailyReminderSummary,
} from "@maneki-pet/core";
import { AssistantError, readAssistantSettings } from "./assistant-settings.js";
import type { AssistantStore } from "./assistant-store.js";

const STATE_KEY = "dailyReminders.v1";
const VERSIONS_KEY = "dailyReminderVersions.v1";
const MAX_STATE_LENGTH = 100_000;
const MAX_VERSIONS_LENGTH = 4096;
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

  private readVersions(): Map<string, number> {
    const raw = this.store.get(VERSIONS_KEY);
    if (raw === null) return new Map();
    if (typeof raw !== "string" || raw.length > MAX_VERSIONS_LENGTH) throw unavailable();
    let saved: { version?: unknown; bySeries?: unknown } | null;
    try { saved = JSON.parse(raw); }
    catch { throw unavailable(); }
    if (saved?.version !== 1 || Object.keys(saved).length !== 2 ||
        !saved.bySeries || typeof saved.bySeries !== "object" || Array.isArray(saved.bySeries)) {
      throw unavailable();
    }
    const entries = Object.entries(saved.bySeries as Record<string, unknown>);
    if (entries.length > MAX_DAILY_REMINDERS) throw unavailable();
    const versions = new Map<string, number>();
    for (const [id, version] of entries) {
      if (!AGENT_REMINDER_UUID_PATTERN.test(id) || typeof version !== "number" ||
          !Number.isSafeInteger(version) || version < 2) throw unavailable();
      versions.set(id, version);
    }
    return versions;
  }

  private saveVersions(rules: Rule[], versions: Map<string, number>): void {
    // 取消规则不依赖版本存储，下一次改期写入时清理已取消的版本。
    const bySeries: Record<string, number> = {};
    for (const { seriesId } of rules) {
      const version = versions.get(seriesId);
      if (version !== undefined) bySeries[seriesId] = version;
    }
    this.store.set(VERSIONS_KEY, JSON.stringify({ version: 1, bySeries }));
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

  listRescheduleTargets(clientId: string): DailyReminderRescheduleTargetList {
    const versions = this.readVersions();
    const { reminders } = this.list(clientId);
    return {
      reminders: reminders.map((rule) => ({ ...rule, version: versions.get(rule.seriesId) ?? 1 })),
    };
  }

  reschedule(actorId: string, ownerId: string, raw: unknown): { receipt: DailyReminderRescheduleReceipt; changed: boolean } {
    const input = normalizeDailyReminderRescheduleInput(raw);
    if (!input) throw new AssistantError(400, "daily_reminder_reschedule_input_invalid");
    const { requestId, seriesId, localTime, version } = input;
    const actor = `daily-reminder-reschedule:${actorId}`;
    const hash = fingerprint([ownerId, seriesId, localTime, version]);
    const nextVersion = version + 1;
    return this.store.transaction(() => {
      const cached = this.store.mutation(actor, requestId);
      if (cached) {
        if (cached.hash !== hash) throw new AssistantError(409, "request_id_conflict");
        let stored: Partial<DailyReminderRescheduleReceipt> | null;
        try { stored = JSON.parse(cached.result); }
        catch { throw unavailable(); }
        const nextAt = stored?.nextAt;
        const timeZone = stored?.timeZone;
        if (!isValidEpoch(nextAt) || typeof timeZone !== "string" || !validTimeZone(timeZone) ||
            !Number.isSafeInteger(nextVersion)) throw unavailable();
        const receipt = { requestId, seriesId, localTime, timeZone, nextAt, version: nextVersion };
        if (cached.result !== JSON.stringify(receipt)) throw unavailable();
        return { receipt, changed: false };
      }

      const rules = this.read();
      const rule = rules.find((item) => item.seriesId === seriesId && item.clientId === ownerId);
      if (!rule) throw new AssistantError(404, "daily_reminder_not_found");
      const versions = this.readVersions();
      if ((versions.get(seriesId) ?? 1) !== version) throw new AssistantError(409, "version_conflict");
      if (rule.localTime === localTime) throw new AssistantError(409, "daily_reminder_time_unchanged");
      if (!Number.isSafeInteger(nextVersion)) throw new AssistantError(409, "daily_reminder_version_exhausted");

      const now = this.now();
      const { timeZone } = rule;
      const today = localParts(now, timeZone).date;
      // 认领和跨日推进都持久化日期。改期只能在该日期及之后安排下一次。
      const firstDate = today > rule.nextDate ? today : rule.nextDate;
      const occurrence = nextOccurrence({ localTime, timeZone }, firstDate, now);
      const receipt = { requestId, seriesId, localTime, timeZone, nextAt: occurrence.nextAt, version: nextVersion };
      this.store.consumeAgentReminderQuota("daily_reschedule", actorId, now);
      this.save(rules.map((item) => item === rule ? moveRule({ ...rule, localTime }, occurrence) : item));
      versions.set(seriesId, nextVersion);
      this.saveVersions(rules, versions);
      this.store.rememberMutation(actor, requestId, hash, receipt);
      return { receipt, changed: true };
    });
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
