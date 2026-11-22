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
type Cadence = "daily" | "weekday";
interface Delivery {
  id: string;
  message: string;
  timeZone: string;
  remindAt: number;
}

const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const nextDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

function isWeekday(date: string): boolean {
  // date 已经是规则时区内的日期，用 UTC 字段计算该日历日期的星期几。
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
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

export class RecurringReminders {
  private parsed: { raw: string; rules: Rule[] } | undefined;
  private readonly stateKey: string;
  private readonly versionsKey: string;

  constructor(
    private readonly store: AssistantStore,
    private readonly now: () => number,
    private readonly cadence: Cadence,
  ) {
    this.stateKey = `${cadence}Reminders.v1`;
    this.versionsKey = `${cadence}ReminderVersions.v1`;
  }

  private unavailable(): AssistantError {
    return new AssistantError(503, `${this.cadence}_reminder_storage_unavailable`);
  }

  private eligibleDate(date: string): boolean {
    return this.cadence === "daily" || isWeekday(date);
  }

  private nextOccurrence(schedule: Schedule, date: string, after = -Infinity): Occurrence {
    // 限制本地时钟或时区数据异常时的同步查找工作量。
    for (let attempt = 0; attempt < 7 && validDateOnly(date); attempt++, date = nextDate(date)) {
      if (!this.eligibleDate(date)) continue;
      const time = localTimeToUtc(`${date}T${schedule.localTime}`, schedule.timeZone);
      if (time !== null && time > after) return { nextDate: date, nextAt: time };
    }
    throw this.unavailable();
  }

  private currentOccurrence(rule: Rule, now: number, days: Map<string, string>): Rule {
    if (rule.occurrence.nextAt > now) return rule;
    let today = days.get(rule.timeZone);
    if (today === undefined) {
      today = localParts(now, rule.timeZone).date;
      days.set(rule.timeZone, today);
    }
    if (rule.nextDate >= today) return rule;
    const occurrence = rule.occurrence.nextDate === today ? rule.occurrence : this.nextOccurrence(rule, today);
    return moveRule(rule, occurrence);
  }

  private read(): Rule[] {
    const raw = this.store.get(this.stateKey);
    if (raw === null) return [];
    if (this.parsed?.raw === raw) return this.parsed.rules;
    if (typeof raw !== "string" || raw.length > MAX_STATE_LENGTH) throw this.unavailable();
    const ids = new Set<string>();
    const counts = new Map<string, number>();
    try {
      const state = JSON.parse(raw) as Partial<State> | null;
      if (state?.version !== 1 || !Array.isArray(state.rules) || state.rules.length > MAX_DAILY_REMINDERS) throw this.unavailable();
      const rules: Rule[] = [];
      for (const rule of state.rules) {
        if (!isStoredRule(rule) || ids.has(rule.seriesId) || !this.eligibleDate(rule.nextDate)) throw this.unavailable();
        const count = (counts.get(rule.clientId) ?? 0) + 1;
        if (count > MAX_DAILY_REMINDERS_PER_CLIENT) throw this.unavailable();
        ids.add(rule.seriesId);
        counts.set(rule.clientId, count);
        rules.push({ ...rule, occurrence: this.nextOccurrence(rule, rule.nextDate) });
      }
      this.parsed = { raw, rules };
      return rules;
    } catch {
      throw this.unavailable();
    }
  }

  private save(rules: Rule[]): void {
    const stored = rules.map(({ occurrence: _occurrence, ...rule }) => rule);
    const raw = JSON.stringify({ version: 1, rules: stored } satisfies State);
    this.store.set(this.stateKey, raw);
    // 后续读取仍比较 SQLite 原值，事务回滚时会重新读取已提交状态。
    this.parsed = { raw, rules };
  }

  create(clientId: string, raw: unknown): DailyReminderReceipt {
    const input = normalizeDailyReminderInput(raw);
    if (!input) throw new AssistantError(400, `${this.cadence}_reminder_input_invalid`);
    const { requestId, localTime, message } = input;
    const owner = `daily-reminder:${clientId}`;
    // 与每日规则共享请求 ID 和创建配额，保留旧每日请求的哈希输入。
    const hash = fingerprint([this.cadence === "daily" ? "create" : "create-weekday", localTime, message]);
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
              !isValidEpoch(value.nextAt)) throw this.unavailable();
          const { seriesId, timeZone, nextAt } = value;
          const receipt = { requestId, seriesId, localTime, timeZone, nextAt };
          if (cached.result !== JSON.stringify(receipt)) throw this.unavailable();
          return receipt;
        } catch {
          throw this.unavailable();
        }
      }
      if (rules.length >= MAX_DAILY_REMINDERS || rules.filter((rule) => rule.clientId === clientId).length >= MAX_DAILY_REMINDERS_PER_CLIENT) {
        throw new AssistantError(409, `${this.cadence}_reminder_limit`);
      }
      const now = this.now();
      const timeZone = readAssistantSettings(this.store).timeZone;
      const occurrence = this.nextOccurrence({ localTime, timeZone }, localParts(now, timeZone).date, now);
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
        .map((rule) => this.currentOccurrence(rule, now, days))
        .sort(compareOccurrences)
        .map(summary),
    };
  }

  cancel(clientId: string, raw: unknown): DailyReminderCancelReceipt {
    const input = normalizeDailyReminderCancelInput(raw);
    if (!input) throw new AssistantError(400, `${this.cadence}_reminder_cancel_input_invalid`);
    const { requestId, seriesId } = input;
    const owner = `daily-reminder:${clientId}`;
    const hash = fingerprint([this.cadence === "daily" ? "cancel" : "cancel-weekday", seriesId]);
    const receipt = { requestId, seriesId, cancelled: true } satisfies DailyReminderCancelReceipt;
    return this.store.transaction(() => {
      const rules = this.read();
      const cached = this.store.mutation(owner, requestId);
      if (cached) {
        if (cached.hash !== hash) throw new AssistantError(409, "request_id_conflict");
        if (cached.result !== JSON.stringify(receipt)) throw this.unavailable();
        return receipt;
      }
      const remaining = rules.filter((rule) => rule.seriesId !== seriesId || rule.clientId !== clientId);
      if (remaining.length === rules.length) throw new AssistantError(404, `${this.cadence}_reminder_not_found`);
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
      const current = rules.map((rule) => this.currentOccurrence(rule, now, days));
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
      const following = this.nextOccurrence(due, nextDate(deliveryDate));
      this.save(current.map((rule) => rule === due ? moveRule(rule, following) : rule));
      return {
        id: `${due.seriesId}:${deliveryDate}`,
        message: due.message,
        timeZone: due.timeZone,
        remindAt: nextAt,
      };
    });
  }

  private readVersions(): Map<string, number> {
    const raw = this.store.get(this.versionsKey);
    if (raw === null) return new Map();
    if (typeof raw !== "string" || raw.length > MAX_VERSIONS_LENGTH) throw this.unavailable();
    let saved: { version?: unknown; bySeries?: unknown } | null;
    try { saved = JSON.parse(raw); }
    catch { throw this.unavailable(); }
    if (saved?.version !== 1 || Object.keys(saved).length !== 2 ||
        !saved.bySeries || typeof saved.bySeries !== "object" || Array.isArray(saved.bySeries)) {
      throw this.unavailable();
    }
    const entries = Object.entries(saved.bySeries as Record<string, unknown>);
    if (entries.length > MAX_DAILY_REMINDERS) throw this.unavailable();
    const versions = new Map<string, number>();
    for (const [id, version] of entries) {
      if (!AGENT_REMINDER_UUID_PATTERN.test(id) || typeof version !== "number" ||
          !Number.isSafeInteger(version) || version < 2) throw this.unavailable();
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
    this.store.set(this.versionsKey, JSON.stringify({ version: 1, bySeries }));
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
    if (!input) throw new AssistantError(400, `${this.cadence}_reminder_reschedule_input_invalid`);
    const { requestId, seriesId, localTime, version } = input;
    const actor = `daily-reminder-reschedule:${actorId}`;
    // 两类共用改期身份的请求 ID。每日沿用已有哈希，工作日带周期以区分同参数的请求。
    const params = [ownerId, seriesId, localTime, version];
    const hash = fingerprint(this.cadence === "daily" ? params : ["weekday", ...params]);
    const nextVersion = version + 1;
    return this.store.transaction(() => {
      const cached = this.store.mutation(actor, requestId);
      if (cached) {
        if (cached.hash !== hash) throw new AssistantError(409, "request_id_conflict");
        let stored: Partial<DailyReminderRescheduleReceipt> | null;
        try { stored = JSON.parse(cached.result); }
        catch { throw this.unavailable(); }
        const nextAt = stored?.nextAt;
        const timeZone = stored?.timeZone;
        if (!isValidEpoch(nextAt) || typeof timeZone !== "string" || !validTimeZone(timeZone) ||
            !Number.isSafeInteger(nextVersion)) throw this.unavailable();
        const receipt = { requestId, seriesId, localTime, timeZone, nextAt, version: nextVersion };
        if (cached.result !== JSON.stringify(receipt)) throw this.unavailable();
        return { receipt, changed: false };
      }

      const rules = this.read();
      const rule = rules.find((item) => item.seriesId === seriesId && item.clientId === ownerId);
      if (!rule) throw new AssistantError(404, `${this.cadence}_reminder_not_found`);
      const versions = this.readVersions();
      if ((versions.get(seriesId) ?? 1) !== version) throw new AssistantError(409, "version_conflict");
      if (rule.localTime === localTime) throw new AssistantError(409, `${this.cadence}_reminder_time_unchanged`);
      if (!Number.isSafeInteger(nextVersion)) throw new AssistantError(409, `${this.cadence}_reminder_version_exhausted`);

      const now = this.now();
      const { timeZone } = rule;
      const today = localParts(now, timeZone).date;
      // 认领和跨日推进都持久化日期。改期只能在该日期及之后安排下一次。
      const firstDate = today > rule.nextDate ? today : rule.nextDate;
      const occurrence = this.nextOccurrence({ localTime, timeZone }, firstDate, now);
      const receipt = { requestId, seriesId, localTime, timeZone, nextAt: occurrence.nextAt, version: nextVersion };
      this.store.consumeAgentReminderQuota("daily_reschedule", actorId, now);
      this.save(rules.map((item) => item === rule ? moveRule({ ...rule, localTime }, occurrence) : item));
      versions.set(seriesId, nextVersion);
      this.saveVersions(rules, versions);
      this.store.rememberMutation(actor, requestId, hash, receipt);
      return { receipt, changed: true };
    });
  }
}
