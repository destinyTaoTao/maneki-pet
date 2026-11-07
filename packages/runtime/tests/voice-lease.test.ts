import { expect, it } from "vitest";
import { defaultAssistantSettings } from "../src/assistant-settings.js";
import { RuntimeStore } from "../src/store.js";
import { VoiceService } from "../src/voice-service.js";
import { EventFeed } from "../src/events.js";
it("重启保留活跃标记时隔离八秒，失效的 owner 未确认停止前不授予第二份", async () => {
  const runtime = new RuntimeStore(":memory:"),
    store = runtime.assistantStore(),
    settings = defaultAssistantSettings();
  settings.voice.microphoneEnabled = true;
  settings.voice.asr.enabled = true;
  store.set("voiceLeaseActive", "1");
  let clock = 0;
  const service = new VoiceService({
    store,
    configDir: "",
    settings: () => settings,
    clock: () => clock,
    feed: new EventFeed(),
    active: () => true,
    chatBusy: () => false,
    submit: () => undefined,
    cancelChat: () => undefined,
    recognizer: () => ({
      info: { id: "fixture", apiVersion: 1, locality: "local" },
      transcribe: async () => ({ text: "" }),
    }),
  });
  try {
    expect(() =>
      service.acquire("one", { requestId: "one", kind: "capture" }),
    ).toThrow("voice_recovering");
    clock = 7999;
    expect(() =>
      service.acquire("one", { requestId: "one", kind: "capture" }),
    ).toThrow("voice_recovering");
    clock = 8000;
    const lease = service.acquire("one", { requestId: "one", kind: "capture" });
    service.invalidate("one");
    expect(() =>
      service.acquire("two", { requestId: "two", kind: "capture" }),
    ).toThrow("voice_busy");
    expect(service.release("two", { leaseId: lease.leaseId }).released).toBe(
      false,
    );
    expect(service.release("one", { leaseId: lease.leaseId }).released).toBe(
      true,
    );
    expect(
      service.acquire("two", { requestId: "two", kind: "capture" }).ttlMs,
    ).toBe(8000);
  } finally {
    await service.stop();
    runtime.close();
  }
});
