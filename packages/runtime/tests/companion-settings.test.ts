import { afterEach, expect, it, vi } from "vitest";
import { RuntimeStore } from "../src/store.js";
import { CompanionStore } from "../src/companion-store.js";
import { defaultAssistantSettings, readAssistantSettings, saveAssistantSettings, settingsView } from "../src/assistant-settings.js";
const stores: RuntimeStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0))
    s.close();
});
function setup() { const r = new RuntimeStore(":memory:"); stores.push(r); const s = r.assistantStore(); const c = new CompanionStore(s); c.initialize(100); return { s, c }; }
function input(version = 0) { const { schemaVersion, voice, ...rest } = defaultAssistantSettings(); return { ...rest, version }; }
it("legacy PUT preserves independent disabled preference and advances version only once", () => {
  const { s, c } = setup();
  saveAssistantSettings(s, "", { ...input(), companion: { murmurEnabled: false } });
  saveAssistantSettings(s, "", input(1));
  expect(settingsView(readAssistantSettings(s), c).companion).toEqual({ murmurEnabled: false, murmurSnoozedUntil: null });
  expect(readAssistantSettings(s).version).toBe(2);
  expect(s.get("settings")).not.toContain("companion");
});
it("explicit null, empty, readonly and unknown fields are rejected", () => {
  const { s } = setup();
  for (const companion of [null, {}, true, { murmurEnabled: 1 }, { murmurEnabled: true, murmurSnoozedUntil: null }, { murmurEnabled: true, extra: true }]) {
    expect(() => saveAssistantSettings(s, "", { ...input(), companion })).toThrow("settings_invalid");
  }
  expect(readAssistantSettings(s).version).toBe(0);
});
it("preferences and settings roll back together when SQLite write fails", () => {
  const { s, c } = setup();
  const old = s.set.bind(s);
  vi.spyOn(s, "set").mockImplementation((key, value) => {
    if (key === "settings")
      throw Error("fixture");
    old(key, value);
  });
  expect(() => saveAssistantSettings(s, "", { ...input(), companion: { murmurEnabled: false } })).toThrow();
  expect(c.readState().preferences.murmurEnabled).toBe(true);
  expect(readAssistantSettings(s).version).toBe(0);
});
it("legacy settings remain readable when companion state is damaged", () => {
  const { s, c } = setup();
  s.set("companion.budget", "{}");
  saveAssistantSettings(s, "", input());
  expect(settingsView(readAssistantSettings(s), c).companion).toBeUndefined();
  expect(() => saveAssistantSettings(s, "", { ...input(1), companion: { murmurEnabled: false } })).not.toThrow();
  expect(() => c.readState()).toThrow("companion_state_unavailable");
});
it("an old v6 settings writer cannot erase independent preferences or mutate reminder state", () => {
  const { s, c } = setup();
  saveAssistantSettings(s, "", { ...input(), companion: { murmurEnabled: false } });
  s.set("settings", JSON.stringify({ ...defaultAssistantSettings(), version: 2 }));
  expect(c.readState().preferences.murmurEnabled).toBe(false);
  expect(s.reminders()).toEqual([]);
});
