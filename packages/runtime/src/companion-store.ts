import type { CompanionBudget, CompanionPreferences } from "@maneki-pet/core";
import { AssistantError } from "./assistant-settings.js";
import type { AssistantStore } from "./assistant-store.js";
const PREF = "companion.preferences", BUDGET = "companion.budget";
const timestamp = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 253402300799999;
const id = (v: unknown) => typeof v === "string" && /^[a-z0-9_-]{1,64}$/.test(v);
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function object(v: unknown, keys: string[]): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)); }
function unavailable(): never { throw new AssistantError(503, "companion_state_unavailable"); }
function preferences(raw: string | null): CompanionPreferences {
  if (raw === null || raw.length > 1024)
    return unavailable();
  try {
    const p: unknown = JSON.parse(raw);
    if (!object(p, ["formatVersion", "murmurEnabled", "murmurSnoozedUntil"]) || p.formatVersion !== 1 || typeof p.murmurEnabled !== "boolean" || (p.murmurSnoozedUntil !== null && !timestamp(p.murmurSnoozedUntil)))
      return unavailable();
    return { murmurEnabled: p.murmurEnabled, murmurSnoozedUntil: p.murmurSnoozedUntil as number | null };
  }
  catch {
    return unavailable();
  }
}
function budget(raw: string | null): CompanionBudget {
  if (raw === null || Buffer.byteLength(raw) > 150000)
    return unavailable();
  try {
    const b: unknown = JSON.parse(raw);
    if (!object(b, ["formatVersion", "initializedAt", "firstEligibleAt", "lastTrustedWallAt", "lastAutomaticAttemptAt", "attempts", "usedTemplates", "lastAutomaticTheme"]) || b.formatVersion !== 1 || !timestamp(b.initializedAt) || !timestamp(b.lastTrustedWallAt) || (b.firstEligibleAt !== null && !timestamp(b.firstEligibleAt)) || (b.lastAutomaticAttemptAt !== null && !timestamp(b.lastAutomaticAttemptAt)) || (b.lastAutomaticTheme !== null && !id(b.lastAutomaticTheme)) || !Array.isArray(b.attempts) || b.attempts.length > 16 || !Array.isArray(b.usedTemplates) || b.usedTemplates.length > 256)
      return unavailable();
    for (const a of b.attempts) {
      if (!object(a, ["utteranceId", "at", "dayKey", "timeZone", "templateId", "contentHash"]) || typeof a.utteranceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(a.utteranceId) || !timestamp(a.at) || typeof a.dayKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(a.dayKey) || typeof a.timeZone !== "string" || a.timeZone.length > 80 || !id(a.templateId) || !hash(a.contentHash))
        return unavailable();
      new Intl.DateTimeFormat("en", { timeZone: a.timeZone });
    }
    for (const u of b.usedTemplates) {
      if (!object(u, ["templateId", "contentHash", "lastUsedAt"]) || !id(u.templateId) || !hash(u.contentHash) || !timestamp(u.lastUsedAt))
        return unavailable();
    }
    return b as unknown as CompanionBudget;
  }
  catch {
    return unavailable();
  }
}
/** 共享 SQLite v6 连接；写方法必须置于调用方同一事务中，不嵌套 BEGIN。 */
export class CompanionStore {
  constructor(private readonly store: AssistantStore) { }
  transaction<T>(run: () => T): T { return this.store.transaction(run); }
  initialize(nowMs: number): void {
    if (!timestamp(nowMs))
      return unavailable();
    this.transaction(() => {
      const p = this.store.get(PREF), b = this.store.get(BUDGET);
      if (p === null && b === null) {
        this.writePreferences({ murmurEnabled: true, murmurSnoozedUntil: null });
        this.writeBudget({ formatVersion: 1, initializedAt: nowMs, firstEligibleAt: null, lastTrustedWallAt: nowMs, lastAutomaticAttemptAt: null, attempts: [], usedTemplates: [], lastAutomaticTheme: null });
      }
      else
        this.readState();
    });
  }
  readPreferences(): CompanionPreferences { return preferences(this.store.get(PREF)); }
  readState(): {
    preferences: CompanionPreferences;
    budget: CompanionBudget;
  } { return { preferences: this.readPreferences(), budget: budget(this.store.get(BUDGET)) }; }
  writePreferences(value: CompanionPreferences): void { const raw = JSON.stringify({ formatVersion: 1, ...value }); preferences(raw); this.store.set(PREF, raw); }
  writeBudget(value: CompanionBudget): void { const raw = JSON.stringify(value); budget(raw); this.store.set(BUDGET, raw); }
}
