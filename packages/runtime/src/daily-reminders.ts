import { createHash, randomUUID } from "node:crypto";
import {
  AGENT_REMINDER_ID_PATTERN,
  AGENT_REMINDER_UUID_PATTERN,
  MAX_DAILY_REMINDERS,
  MAX_DAILY_REMINDERS_PER_CLIENT,
  MAX_WEEKLY_REMINDERS,
  MAX_WEEKLY_REMINDERS_PER_CLIENT,
  localParts,
  localTimeToUtc,
  normalizeDailyReminderCancelInput,
  normalizeDailyReminderInput,
  normalizeDailyReminderRescheduleInput,
  normalizeWeeklyReminderDays,
  normalizeWeeklyReminderInput,
  normalizeWeeklyReminderRescheduleInput,
  validDateOnly,
  validTimeZone,
  type DailyReminderCancelReceipt,
  type DailyReminderInput,
  type DailyReminderList,
  type DailyReminderReceipt,
  type DailyReminderRescheduleReceipt,
  type DailyReminderRescheduleTargetList,
  type DailyReminderSummary,
  type WeeklyReminderList,
  type WeeklyReminderReceipt,
  type WeeklyReminderRescheduleInput,
  type WeeklyReminderRescheduleReceipt,
  type WeeklyReminderRescheduleTargetList,
} from "@maneki-pet/core";
import { AssistantError, readAssistantSettings } from "./assistant-settings.js";
import type { AssistantStore } from "./assistant-store.js";

const MAX_STATE_LENGTH = 100_000;
const MAX_VERSIONS_LENGTH = 4096;
const MAX_DATE_FLOORS_LENGTH = 8192;
const WEEKLY_DATE_FLOORS_KEY = "weeklyReminderDateFloors.v1";
const DAY_MS = 86_400_000;

interface Occurrence {
  nextDate: string;
  nextAt: number;
}
interface StoredRule extends Omit<DailyReminderSummary, "nextAt"> {
  clientId: string;
  nextDate: string;
  daysOfWeek?: number[];
}
interface Rule extends StoredRule {
  occurrence: Occurrence;
}
interface State {
  version: 1;
  rules: StoredRule[];
}
interface DateFloor {
  firstDate: string;
  nextDate: string;
}
type Schedule = Pick<StoredRule, "timeZone" | "localTime" | "daysOfWeek">;
type ScheduleDays = Pick<Schedule, "daysOfWeek">;
type Cadence = "daily" | "weekday" | "weekly";
interface Delivery {
  id: string;
  message: string;
  timeZone: string;
  remindAt: number;
}

const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const offsetDate = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const laterDate = (a: string, b: string) => a > b ? a : b;

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

function isDateFloor(value: unknown): value is DateFloor {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 2) return false;
  const { firstDate, nextDate } = value as Partial<DateFloor>;
  return typeof firstDate === "string" && validDateOnly(firstDate) && typeof nextDate === "string" &&
    validDateOnly(nextDate) && firstDate <= nextDate;
}

function isStoredRule(value: unknown, weekly: boolean): value is StoredRule {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).length !== (weekly ? 7 : 6)) return false;
  const rule = value as Partial<StoredRule>;
  if (weekly) {
    const normalizedDays = normalizeWeeklyReminderDays(rule.daysOfWeek);
    if (!normalizedDays || !normalizedDays.every((day, index) => day === rule.daysOfWeek?.[index])) return false;
  }
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
  private readonly maxRules: number;
  private readonly maxRulesPerClient: number;

  constructor(
    private readonly store: AssistantStore,
    private readonly now: () => number,
    private readonly cadence: Cadence,
  ) {
    this.stateKey = `${cadence}Reminders.v1`;
    this.versionsKey = `${cadence}ReminderVersions.v1`;
    this.maxRules = cadence === "weekly" ? MAX_WEEKLY_REMINDERS : MAX_DAILY_REMINDERS;
    this.maxRulesPerClient = cadence === "weekly" ? MAX_WEEKLY_REMINDERS_PER_CLIENT : MAX_DAILY_REMINDERS_PER_CLIENT;
  }

  private unavailable(): AssistantError {
    return new AssistantError(503, `${this.cadence}_reminder_storage_unavailable`);
  }

  private eligibleDate(date: string, schedule: ScheduleDays): boolean {
    if (this.cadence === "daily") return true;
    // date 是规则时区内的日期，借 UTC 字段计算该日历日期的 ISO 星期。
    const day = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
    return this.cadence === "weekday" ? day <= 5 : schedule.daysOfWeek?.includes(day) === true;
  }

  private nextOccurrence(schedule: Schedule, date: string, after = -Infinity): Occurrence {
    // 限制本地时钟或时区数据异常时的同步查找工作量。
    // 每周只选一天时，今天的时刻已过且下周被 DST 跳过，需查到第 14 天。
    const limit = this.cadence === "weekly" ? 15 : 7;
    for (let attempt = 0; attempt < limit && validDateOnly(date); attempt++, date = offsetDate(date, 1)) {
      if (!this.eligibleDate(date, schedule)) continue;
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
      if (state?.version !== 1 || !Array.isArray(state.rules) || state.rules.length > this.maxRules) throw this.unavailable();
      const rules: Rule[] = [];
      for (const rule of state.rules) {
        if (!isStoredRule(rule, this.cadence === "weekly") || ids.has(rule.seriesId) ||
            !this.eligibleDate(rule.nextDate, rule)) throw this.unavailable();
        const count = (counts.get(rule.clientId) ?? 0) + 1;
        if (count > this.maxRulesPerClient) throw this.unavailable();
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

  private readWeeklyDateFloors(): Map<string, DateFloor> | null {
    if (this.cadence !== "weekly") return null;
    const raw = this.store.get(WEEKLY_DATE_FLOORS_KEY);
    if (raw === null) return new Map();
    if (typeof raw !== "string" || raw.length > MAX_DATE_FLOORS_LENGTH) throw this.unavailable();
    let saved: { version?: unknown; bySeries?: unknown } | null;
    try { saved = JSON.parse(raw); }
    catch { throw this.unavailable(); }
    if (saved?.version !== 1 || Object.keys(saved).length !== 2 ||
        !saved.bySeries || typeof saved.bySeries !== "object" || Array.isArray(saved.bySeries)) {
      throw this.unavailable();
    }
    const entries = Object.entries(saved.bySeries as Record<string, unknown>);
    if (entries.length > this.maxRules) throw this.unavailable();
    const floors = new Map<string, DateFloor>();
    for (const [id, floor] of entries) {
      if (!AGENT_REMINDER_UUID_PATTERN.test(id) || !isDateFloor(floor)) throw this.unavailable();
      floors.set(id, floor);
    }
    return floors;
  }

  private weeklyFirstDate(rule: Rule, saved: DateFloor | undefined): string {
    if (saved?.nextDate === rule.nextDate) return saved.firstDate;
    // 旧 Runtime 只写下一次指定日期，前一次可能已认领，保守地从其后一天开始。
    let firstDate = rule.nextDate;
    for (let distance = 1; distance <= 7; distance++) {
      const date = offsetDate(rule.nextDate, -distance);
      if (this.eligibleDate(date, rule)) {
        firstDate = offsetDate(date, 1);
        break;
      }
    }
    return saved ? laterDate(saved.firstDate, firstDate) : firstDate;
  }

  private save(rules: Rule[], dateFloors: Map<string, DateFloor> | null): void {
    const stored = rules.map(({ occurrence: _occurrence, ...rule }) => rule);
    const raw = JSON.stringify({ version: 1, rules: stored } satisfies State);
    this.store.set(this.stateKey, raw);
    if (dateFloors) {
      // 同一事务维护有界的活跃规则下界，也清理旧 Runtime 已取消的系列。
      const bySeries: Record<string, DateFloor> = {};
      for (const { seriesId } of rules) {
        const floor = dateFloors.get(seriesId);
        if (floor) bySeries[seriesId] = floor;
      }
      this.store.set(WEEKLY_DATE_FLOORS_KEY, JSON.stringify({ version: 1, bySeries }));
    }
    // 后续读取仍比较 SQLite 原值，事务回滚时会重新读取已提交状态。
    this.parsed = { raw, rules };
  }

  create(clientId: string, raw: unknown): DailyReminderReceipt {
    const input = normalizeDailyReminderInput(raw);
    if (!input) throw new AssistantError(400, `${this.cadence}_reminder_input_invalid`);
    return this.createRule(clientId, input, {});
  }

  createWeekly(clientId: string, raw: unknown): WeeklyReminderReceipt {
    const input = normalizeWeeklyReminderInput(raw);
    if (!input) throw new AssistantError(400, "weekly_reminder_input_invalid");
    return this.createRule(clientId, input, { daysOfWeek: [...input.daysOfWeek] });
  }

  private createRule<Days extends ScheduleDays>(
    clientId: string,
    { requestId, localTime, message }: DailyReminderInput,
    days: Days,
  ): DailyReminderReceipt & Days {
    const owner = `daily-reminder:${clientId}`;
    // 所有周期共享请求 ID 和创建配额，保留旧每日和工作日请求的哈希输入。
    const action = this.cadence === "daily" ? "create" : `create-${this.cadence}`;
    const args = [action, localTime, message];
    const hash = fingerprint(days.daysOfWeek ? [...args, days.daysOfWeek] : args);
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
          const receipt = { requestId, seriesId, localTime, timeZone, nextAt, ...days };
          if (cached.result !== JSON.stringify(receipt)) throw this.unavailable();
          return receipt;
        } catch {
          throw this.unavailable();
        }
      }
      if (rules.length >= this.maxRules || rules.filter((rule) => rule.clientId === clientId).length >= this.maxRulesPerClient) {
        throw new AssistantError(409, `${this.cadence}_reminder_limit`);
      }
      const now = this.now();
      const timeZone = readAssistantSettings(this.store).timeZone;
      // 缓存的规则与返回给调用方的回执不共享星期数组。
      const schedule = days.daysOfWeek ? { localTime, timeZone, daysOfWeek: [...days.daysOfWeek] } : { localTime, timeZone };
      const today = localParts(now, timeZone).date;
      const occurrence = this.nextOccurrence(schedule, today, now);
      const seriesId = randomUUID();
      const receipt = { requestId, seriesId, localTime, timeZone, nextAt: occurrence.nextAt, ...days };
      const dateFloors = this.readWeeklyDateFloors();
      dateFloors?.set(seriesId, { firstDate: today, nextDate: occurrence.nextDate });
      this.store.consumeAgentReminderQuota("daily_creation", clientId, now);
      this.save([...rules, {
        nextDate: occurrence.nextDate, occurrence, seriesId, clientId, localTime, message, timeZone,
        ...(schedule.daysOfWeek && { daysOfWeek: schedule.daysOfWeek }),
      }], dateFloors);
      this.store.rememberMutation(owner, requestId, hash, receipt);
      return receipt;
    });
  }

  list(clientId: string): DailyReminderList {
    return { reminders: this.listRules(clientId).map(summary) };
  }

  listWeekly(clientId: string): WeeklyReminderList {
    return {
      reminders: this.listRules(clientId).map((rule) => ({ ...summary(rule), ...this.weeklyDays(rule) })),
    };
  }

  private weeklyDays(source: ScheduleDays): Required<ScheduleDays> {
    const daysOfWeek = normalizeWeeklyReminderDays(source.daysOfWeek);
    if (!daysOfWeek) throw this.unavailable();
    return { daysOfWeek };
  }

  private listRules(clientId: string): Rule[] {
    const now = this.now();
    const days = new Map<string, string>();
    return this.read().filter((rule) => rule.clientId === clientId)
      .map((rule) => this.currentOccurrence(rule, now, days))
      .sort(compareOccurrences);
  }

  cancel(clientId: string, raw: unknown): DailyReminderCancelReceipt {
    const input = normalizeDailyReminderCancelInput(raw);
    if (!input) throw new AssistantError(400, `${this.cadence}_reminder_cancel_input_invalid`);
    const { requestId, seriesId } = input;
    const owner = `daily-reminder:${clientId}`;
    const hash = fingerprint([this.cadence === "daily" ? "cancel" : `cancel-${this.cadence}`, seriesId]);
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
      let dateFloors: Map<string, DateFloor> | null;
      try { dateFloors = this.readWeeklyDateFloors(); }
      catch (error) {
        if (!(error instanceof AssistantError) || error.code !== "weekly_reminder_storage_unavailable") throw error;
        // 损坏的下界仍可能含其他系列的历史，取消最后一个系列时才能安全清空。
        dateFloors = remaining.length === 0 ? new Map() : null;
      }
      this.save(remaining, dateFloors);
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
      const advanced = current.some((rule, index) => rule !== rules[index]);
      if (!due && !advanced) return null;
      const dateFloors = this.readWeeklyDateFloors();
      if (dateFloors && advanced) {
        for (const [index, rule] of current.entries()) {
          if (rule !== rules[index]) {
            // currentOccurrence 跨日推进时已经按时区计算了本地日期。
            const today = days.get(rule.timeZone)!;
            const firstDate = laterDate(today, dateFloors.get(rule.seriesId)?.firstDate ?? today);
            if (firstDate > rule.nextDate) throw this.unavailable();
            dateFloors.set(rule.seriesId, { firstDate, nextDate: rule.nextDate });
          }
        }
      }
      if (!due) {
        this.save(current, dateFloors);
        return null;
      }
      // 认领提交后该日期不再可调度，即使通知器失败或进程退出。
      const { nextDate: deliveryDate, nextAt } = due.occurrence;
      const saved = dateFloors?.get(due.seriesId);
      if (saved && deliveryDate < saved.firstDate) throw this.unavailable();
      const firstDate = offsetDate(deliveryDate, 1);
      const following = this.nextOccurrence(due, firstDate);
      dateFloors?.set(due.seriesId, { firstDate, nextDate: following.nextDate });
      this.save(current.map((rule) => rule === due ? moveRule(rule, following) : rule), dateFloors);
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
    if (entries.length > this.maxRules) throw this.unavailable();
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
    return this.listVersionedRules(clientId, summary);
  }

  listWeeklyRescheduleTargets(clientId: string): WeeklyReminderRescheduleTargetList {
    return this.listVersionedRules(clientId, (rule) => ({ ...summary(rule), ...this.weeklyDays(rule) }));
  }

  private listVersionedRules<Summary extends DailyReminderSummary>(clientId: string, summarize: (rule: Rule) => Summary) {
    const versions = this.readVersions();
    return {
      reminders: this.listRules(clientId).map((rule) => ({ ...summarize(rule), version: versions.get(rule.seriesId) ?? 1 })),
    };
  }

  reschedule(actorId: string, ownerId: string, raw: unknown): { receipt: DailyReminderRescheduleReceipt; changed: boolean } {
    return this.rescheduleRule(actorId, ownerId, normalizeDailyReminderRescheduleInput(raw), () => ({}));
  }

  rescheduleWeekly(actorId: string, ownerId: string, raw: unknown): { receipt: WeeklyReminderRescheduleReceipt; changed: boolean } {
    return this.rescheduleRule(actorId, ownerId, normalizeWeeklyReminderRescheduleInput(raw), (source) => this.weeklyDays(source));
  }

  private rescheduleRule<Days extends ScheduleDays>(
    actorId: string, ownerId: string, input: WeeklyReminderRescheduleInput | null,
    getDays: (source: ScheduleDays) => Days,
  ): { receipt: DailyReminderRescheduleReceipt & Days; changed: boolean } {
    if (!input) throw new AssistantError(400, `${this.cadence}_reminder_reschedule_input_invalid`);
    const { requestId, seriesId, localTime, version, daysOfWeek } = input;
    const actor = `daily-reminder-reschedule:${actorId}`;
    // 各周期共用改期身份的请求 ID。每日保留原哈希，其他周期带周期名称。
    const params = daysOfWeek ? [ownerId, seriesId, localTime, version, daysOfWeek] : [ownerId, seriesId, localTime, version];
    const hash = fingerprint(this.cadence === "daily" ? params : [this.cadence, ...params]);
    const nextVersion = version + 1;
    return this.store.transaction(() => {
      const cached = this.store.mutation(actor, requestId);
      if (cached) {
        if (cached.hash !== hash) throw new AssistantError(409, "request_id_conflict");
        let stored: (Partial<DailyReminderRescheduleReceipt> & ScheduleDays) | null;
        try { stored = JSON.parse(cached.result); }
        catch { throw this.unavailable(); }
        const nextAt = stored?.nextAt;
        const timeZone = stored?.timeZone;
        if (!stored || !isValidEpoch(nextAt) || typeof timeZone !== "string" || !validTimeZone(timeZone) ||
            !Number.isSafeInteger(nextVersion)) throw this.unavailable();
        const days = getDays(daysOfWeek ? { daysOfWeek: [...daysOfWeek] } : stored);
        const receipt = { requestId, seriesId, localTime, timeZone, nextAt, version: nextVersion, ...days };
        if (cached.result !== JSON.stringify(receipt)) throw this.unavailable();
        return { receipt, changed: false };
      }

      const rules = this.read();
      const rule = rules.find((item) => item.seriesId === seriesId && item.clientId === ownerId);
      if (!rule) throw new AssistantError(404, `${this.cadence}_reminder_not_found`);
      const versions = this.readVersions();
      if ((versions.get(seriesId) ?? 1) !== version) throw new AssistantError(409, "version_conflict");
      const daysChanged = daysOfWeek !== undefined && (daysOfWeek.length !== rule.daysOfWeek?.length ||
        !daysOfWeek.every((day, index) => day === rule.daysOfWeek?.[index]));
      if (rule.localTime === localTime && !daysChanged) {
        throw new AssistantError(409, `${this.cadence}_reminder_time_unchanged`);
      }
      if (!Number.isSafeInteger(nextVersion)) throw new AssistantError(409, `${this.cadence}_reminder_version_exhausted`);

      const now = this.now();
      const { timeZone } = rule;
      const today = localParts(now, timeZone).date;
      const dateFloors = this.readWeeklyDateFloors();
      const floor = dateFloors ? laterDate(today, this.weeklyFirstDate(rule, dateFloors.get(seriesId))) : today;
      // 只改时刻沿用已选日期约束；更换星期可选日期下界后的其他日期。
      const firstDate = daysChanged ? floor : laterDate(floor, rule.nextDate);
      const updated = { ...rule, localTime, ...(daysOfWeek && { daysOfWeek: [...daysOfWeek] }) };
      const occurrence = this.nextOccurrence(updated, firstDate, now);
      const receipt = { requestId, seriesId, localTime, timeZone, nextAt: occurrence.nextAt, version: nextVersion, ...getDays(updated) };
      dateFloors?.set(seriesId, { firstDate: floor, nextDate: occurrence.nextDate });
      this.store.consumeAgentReminderQuota("daily_reschedule", actorId, now);
      this.save(rules.map((item) => item === rule ? moveRule(updated, occurrence) : item), dateFloors);
      versions.set(seriesId, nextVersion);
      this.saveVersions(rules, versions);
      this.store.rememberMutation(actor, requestId, hash, receipt);
      return { receipt, changed: true };
    });
  }
}
