import { companionLimits, type CompanionPreferences, type CompanionBudget, type CompanionStatus } from "./companion-types.js";
export interface CompanionPolicyInput {
  nowMs: number;
  timeZone: string;
  preferences: CompanionPreferences;
  budget: CompanionBudget | null;
  dnd: boolean;
  storageHealthy: boolean;
  clockTrusted: boolean;
  displayAvailable: boolean;
  contentAvailable: boolean;
}
export function companionDayKey(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  return ["year", "month", "day"].map(key => parts.find(p => p.type === key)!.value).join("-");
}
/** 搜索下一个本地日期边界，不假设一天永远为24小时（夏令时）。 */
function nextDay(now: number, zone: string): number {
  const key = companionDayKey(now, zone);
  let lo = now, hi = now + 27 * 3600000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (companionDayKey(mid, zone) === key)
      lo = mid;
    else
      hi = mid;
  }
  return hi;
}
const timestamp = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 253402300799999;
export function evaluateCompanion(input: CompanionPolicyInput): {
  allowed: boolean;
  reason: CompanionStatus["automaticBlock"];
  nextEligibleAt: number | null;
} {
  const { nowMs: now, timeZone: zone, budget: b, preferences: p } = input;
  const block = (reason: CompanionStatus["automaticBlock"], nextEligibleAt: number | null = null) => ({ allowed: false, reason, nextEligibleAt });
  if (!input.storageHealthy || !b || b.formatVersion !== 1 || !timestamp(now) || !timestamp(b.initializedAt) || !timestamp(b.lastTrustedWallAt) || (b.firstEligibleAt !== null && !timestamp(b.firstEligibleAt)) || (b.lastAutomaticAttemptAt !== null && !timestamp(b.lastAutomaticAttemptAt)) || !Array.isArray(b.attempts) || b.attempts.length > 16 || !Array.isArray(b.usedTemplates) || b.usedTemplates.length > 256 || b.attempts.some(a => !timestamp(a.at)) || typeof p.murmurEnabled !== "boolean" || (p.murmurSnoozedUntil !== null && !timestamp(p.murmurSnoozedUntil)))
    return block("storage_unavailable");
  if (!input.clockTrusted || now < b.lastTrustedWallAt)
    return block("clock_untrusted");
  if (!p.murmurEnabled)
    return block("disabled");
  if (p.murmurSnoozedUntil !== null && now < p.murmurSnoozedUntil)
    return block("snoozed", p.murmurSnoozedUntil);
  if (input.dnd)
    return block("dnd");
  if (!input.displayAvailable)
    return block("no_display");
  if (b.firstEligibleAt === null)
    return block("warming_up");
  const warm = b.firstEligibleAt + companionLimits.minIntervalMs;
  if (now < warm)
    return block("warming_up", warm);
  let at = b.lastAutomaticAttemptAt === null ? now : b.lastAutomaticAttemptAt + companionLimits.minIntervalMs;
  const rolling = b.attempts.filter(a => a.at > now - 86400000).sort((a, c) => a.at - c.at);
  if (rolling.length >= 4)
    at = Math.max(at, rolling[rolling.length - 4]!.at + 86400000);
  try {
    const key = companionDayKey(now, zone);
    if (b.attempts.filter(a => companionDayKey(a.at, zone) === key).length >= 4)
      at = Math.max(at, nextDay(now, zone));
  }
  catch {
    return block("storage_unavailable");
  }
  if (at > now)
    return block("budget", at);
  if (!input.contentAvailable)
    return block("no_content");
  return { allowed: true, reason: null, nextEligibleAt: null };
}
