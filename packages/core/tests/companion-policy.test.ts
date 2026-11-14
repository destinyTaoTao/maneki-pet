import { describe, expect, it } from "vitest";
import { companionTemplates, evaluateCompanion, selectCompanionTemplate, type CompanionPolicyInput, type CompanionBudget } from "../src/index.js";
const H = 3600000;
const now = Date.UTC(2026, 10, 14, 12);
const budget = (): CompanionBudget => ({ formatVersion: 1, initializedAt: now - 3 * H, firstEligibleAt: now - 2 * H, lastTrustedWallAt: now, lastAutomaticAttemptAt: null, attempts: [], usedTemplates: [], lastAutomaticTheme: null });
const eligible = (): CompanionPolicyInput => ({ nowMs: now, timeZone: "Asia/Shanghai", preferences: { murmurEnabled: true, murmurSnoozedUntil: null }, budget: budget(), dnd: false, storageHealthy: true, clockTrusted: true, displayAvailable: true, contentAvailable: true });
describe("companion automatic policy", () => {
  it("admits only after the exact two hour warmup", () => {
    const input = eligible();
    input.budget!.firstEligibleAt = now - 2 * H + 1;
    expect(evaluateCompanion(input)).toMatchObject({ allowed: false, reason: "warming_up", nextEligibleAt: now + 1 });
    input.nowMs++;
    expect(evaluateCompanion(input).allowed).toBe(true);
  });
  it("orders independent failure reasons conservatively", () => {
    expect(evaluateCompanion({ ...eligible(), storageHealthy: false, clockTrusted: false, dnd: true }).reason).toBe("storage_unavailable");
    expect(evaluateCompanion({ ...eligible(), clockTrusted: false, dnd: true }).reason).toBe("clock_untrusted");
    expect(evaluateCompanion({ ...eligible(), preferences: { murmurEnabled: false, murmurSnoozedUntil: now + H }, dnd: true }).reason).toBe("disabled");
    expect(evaluateCompanion({ ...eligible(), preferences: { murmurEnabled: true, murmurSnoozedUntil: now + 1 } }).reason).toBe("snoozed");
    expect(evaluateCompanion({ ...eligible(), dnd: true }).reason).toBe("dnd");
    expect(evaluateCompanion({ ...eligible(), displayAvailable: false }).reason).toBe("no_display");
    expect(evaluateCompanion({ ...eligible(), contentAvailable: false }).reason).toBe("no_content");
  });
  it("keeps interval at the exact boundary across zone changes", () => {
    const input = eligible();
    input.budget!.lastAutomaticAttemptAt = now - 2 * H + 1;
    expect(evaluateCompanion(input)).toMatchObject({ reason: "budget", nextEligibleAt: now + 1 });
    input.nowMs++;
    input.timeZone = "America/New_York";
    expect(evaluateCompanion(input).allowed).toBe(true);
  });
  it("does not replenish a rolling day at midnight or after changing time zone", () => {
    const input = eligible();
    input.budget!.attempts = [23, 20, 17, 14].map(h => ({ utteranceId: String(h), at: now - h * H, dayKey: "2026-11-13", timeZone: "UTC", templateId: "a", contentHash: "a".repeat(64) }));
    expect(evaluateCompanion(input)).toMatchObject({ reason: "budget", nextEligibleAt: now + H });
    input.nowMs += H;
    expect(evaluateCompanion(input).allowed).toBe(true);
  });
  it("enforces a 25-hour local day across equivalent time-zone names", () => {
    const input=eligible();input.nowMs=Date.UTC(2026,10,2,4,50);input.timeZone="US/Eastern";
    input.budget!.initializedAt=input.nowMs-48*H;input.budget!.firstEligibleAt=input.nowMs-48*H;
    input.budget!.lastTrustedWallAt=input.nowMs;
    input.budget!.attempts=[0,2,4,6].map(h=>({utteranceId:String(h),at:Date.UTC(2026,10,1,4,10)+h*H,dayKey:"2026-11-01",timeZone:"America/New_York",templateId:"a",contentHash:"a".repeat(64)}));
    expect(evaluateCompanion(input)).toMatchObject({reason:"budget",nextEligibleAt:Date.UTC(2026,10,2,5)});
  });
  it("blocks missing warmup and corrupted budget without inventing capacity", () => {
    const input = eligible();
    input.budget!.firstEligibleAt = null;
    expect(evaluateCompanion(input).reason).toBe("warming_up");
    expect(evaluateCompanion({ ...eligible(), budget: null }).reason).toBe("storage_unavailable");
    input.budget!.lastAutomaticAttemptAt = NaN;
    expect(evaluateCompanion(input).reason).toBe("storage_unavailable");
  });
});
describe("original companion catalog", () => {
  it("is bounded, plain, original and structurally valid", () => {
    expect(companionTemplates).toHaveLength(24);
    expect(new Set(companionTemplates.map(t => t.theme)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(companionTemplates.map(t => t.id)).size).toBe(24);
    expect(new Set(companionTemplates.map(t => t.text.normalize("NFC").trim())).size).toBe(24);
    for (const t of companionTemplates) {
      expect(t.id).toMatch(/^[a-z0-9_-]{1,64}$/);
      expect(t.theme).toMatch(/^[a-z0-9_-]{1,64}$/);
      expect(t.text.length).toBeLessThanOrEqual(80);
      expect(t.text.trim().length).toBeGreaterThan(0);
      expect(t.hours.every(h => Number.isInteger(h) && h >= 0 && h < 24)).toBe(true);
    }
  });
  it("automatically excludes used IDs, adjacent themes and unsuitable hours", () => {
    const pool = [{ id: "a", theme: "stretch", text: "甲", hours: [], actionId: null }, { id: "b", theme: "greet", text: "乙", hours: [8], actionId: null }, { id: "c", theme: "quiet", text: "丙", hours: [], actionId: null }];
    expect(selectCompanionTemplate({ mode: "automatic", hour: 12, excludedIds: new Set(), lastTheme: "stretch", lastTemplateId: null }, pool)?.id).toBe("c");
    expect(selectCompanionTemplate({ mode: "automatic", hour: 12, excludedIds: new Set(["c"]), lastTheme: "stretch", lastTemplateId: null }, pool)).toBeNull();
    expect(selectCompanionTemplate({ mode: "manual", hour: 12, excludedIds: new Set(["a", "c"]), lastTheme: null, lastTemplateId: "a" }, pool)?.id).toBe("c");
  });
});
