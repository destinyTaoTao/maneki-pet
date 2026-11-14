import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { RuntimeStore } from "../src/store.js";
import { CompanionStore } from "../src/companion-store.js";
import { CompanionClock } from "../src/companion-clock.js";
const stores: RuntimeStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0))
    s.close();
});
function setup() { const runtime = new RuntimeStore(":memory:"); stores.push(runtime); const assistant = runtime.assistantStore(); return { runtime, assistant, store: new CompanionStore(assistant) }; }
it("initializes two independent keys atomically and preserves warmup across reopen", () => {
  const { store, assistant } = setup();
  store.initialize(100);
  store.transaction(() => { const b = store.readState().budget; b.firstEligibleAt = 200; store.writeBudget(b); });
  new CompanionStore(assistant).initialize(500);
  expect(store.readState().budget).toMatchObject({ initializedAt: 100, firstEligibleAt: 200 });
  expect(JSON.parse(assistant.get("companion.preferences")!)).toEqual({ formatVersion: 1, murmurEnabled: true, murmurSnoozedUntil: null });
});
it("does not repair partial state or overwrite unknown future formats", () => {
  const { store, assistant } = setup();
  assistant.set("companion.preferences", JSON.stringify({ formatVersion: 2, murmurEnabled: false, murmurSnoozedUntil: null }));
  expect(() => store.initialize(100)).toThrow("companion_state_unavailable");
  expect(assistant.get("companion.budget")).toBeNull();
  expect(() => store.readState()).toThrow("companion_state_unavailable");
});
it("rolls back both keys on initialization failure", () => {
  const { store, assistant } = setup();
  const original = assistant.set.bind(assistant);
  vi.spyOn(assistant, "set").mockImplementation((k, v) => {
    if (k === "companion.budget")
      throw Error("fixture");
    original(k, v);
  });
  expect(() => store.initialize(100)).toThrow();
  expect(assistant.get("companion.preferences")).toBeNull();
});
it("rejects corrupt and unbounded records rather than inventing unused budget", () => {
  const { store, assistant } = setup();
  store.initialize(100);
  const good = store.readState().budget;
  for (const patch of [{ attempts: Array(17).fill({}) }, { usedTemplates: Array(257).fill({}) }, { lastTrustedWallAt: -1 }, { firstEligibleAt: 1.2 }, { extra: true }, { lastAutomaticTheme: "bad theme" }]) {
    assistant.set("companion.budget", JSON.stringify({ ...good, ...patch }));
    expect(() => store.readState()).toThrow("companion_state_unavailable");
  }
});
it("clock rollback across restart requires watermark recovery and two monotonic hours", () => {
  let wall = 1000, mono = 0;
  const clock = new CompanionClock(() => wall, () => mono);
  expect(clock.sample(2000).trusted).toBe(false);
  wall = 2000;
  mono = 1000;
  expect(clock.sample(2000).trusted).toBe(false);
  wall += 7199000;
  mono += 7199000;
  expect(clock.sample(2000).trusted).toBe(true);
});
it("clock forward/backward jumps require two monotonic hours of stable observations", () => {
  let wall = 100000, mono = 0;
  const clock = new CompanionClock(() => wall, () => mono);
  expect(clock.sample(100000).trusted).toBe(true);
  wall += 3600000;
  mono += 1000;
  expect(clock.sample(100000).trusted).toBe(false);
  wall += 7199999;
  mono += 7199999;
  expect(clock.sample(100000).trusted).toBe(false);
  wall++;
  mono++;
  expect(clock.sample(100000).trusted).toBe(true);
  wall -= 10000;
  mono++;
  expect(clock.sample(100000).trusted).toBe(false);
});
it("reopen retains attempts, warmup and accepted reminder without changing SQLite v6", () => {
  const dir = mkdtempSync(join(tmpdir(), "maneki-companion-store-")), file = join(dir, "runtime.sqlite");
  let runtime: RuntimeStore | undefined;
  try {
    runtime = new RuntimeStore(file);
    const assistant = runtime.assistantStore(), store = new CompanionStore(assistant);
    store.initialize(100);
    assistant.saveReminder({ id: "r", todoId: null, message: "fixture", remindAt: 100, timeZone: "UTC", status: "accepted", attempts: 1, code: null, version: 2 });
    store.transaction(() => { const b = store.readState().budget; b.firstEligibleAt = 100; b.lastAutomaticAttemptAt = 7200100; b.lastTrustedWallAt = 7200100; b.attempts = [{ utteranceId: "11111111-1111-4111-8111-111111111111", at: 7200100, dayKey: "1970-01-01", timeZone: "UTC", templateId: "company_1", contentHash: "a".repeat(64) }]; store.writeBudget(b); store.writePreferences({ murmurEnabled: false, murmurSnoozedUntil: 14400100 }); });
    const before = assistant.reminders();
    runtime.close();
    runtime = undefined;
    runtime = new RuntimeStore(file);
    const reopened = runtime.assistantStore(), companion = new CompanionStore(reopened);
    companion.initialize(7200200);
    expect(companion.readState()).toMatchObject({ preferences: { murmurEnabled: false, murmurSnoozedUntil: 14400100 }, budget: { firstEligibleAt: 100, lastAutomaticAttemptAt: 7200100, attempts: [{ templateId: "company_1" }] } });
    expect(reopened.reminders()).toEqual(before);
    const read = new DatabaseSync(file, { readOnly: true });
    try {
      expect(read.prepare("SELECT MAX(version) AS v FROM schema_migrations").get()?.v).toBe(6);
    }
    finally {
      read.close();
    }
  }
  finally {
    runtime?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("clock stays blocked after two hours if persistent watermark has not been reached", () => {
  let wall = 1000, mono = 0;
  const c = new CompanionClock(() => wall, () => mono);
  expect(c.sample(10000000).trusted).toBe(false);
  wall += 7200000;
  mono += 7200000;
  expect(c.sample(10000000).trusted).toBe(false);
});
