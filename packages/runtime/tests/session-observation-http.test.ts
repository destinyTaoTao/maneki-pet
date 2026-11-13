import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { startRuntime } from "../src/runtime.js";
import { defaultAssistantSettings } from "../src/assistant-settings.js";
import { captureWave } from "@maneki-pet/core";

it("正式 HTTP 面板快照和无模型查询共用会话事实，上报凭证不能读取个人快照", async () => {
  const directory = mkdtempSync(join(tmpdir(), "maneki-observation-http-"));
  const provider = vi.fn();
  const runtime = await startRuntime({ configDir: directory, notifier: { notify: vi.fn() }, chatProvider: provider,
    speech: { recognizer: () => ({ info: { id: "fixture", apiVersion: 1, locality: "local" }, transcribe: async () => ({ text: "查看進度" }) }) },
  });
  const call = async (path: string, token: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  try {
    const observer = await call("/pair", runtime.rootToken, { name: "dsh-test", scopes: "express" });
    const assistant = await call("/pair", runtime.rootToken, { name: "assistant-test", scopes: "assistant" });
    const token = String(observer.body.token), assistantToken = String(assistant.body.token);
    const report = {
      sourceId: "00000000-0000-4000-8000-000000000001", reportSequence: 1, profileId: "web", connected: true, truncated: false,
      sessions: [
        { sessionId: "session-A", projectName: "project-A", phase: "waiting_input", sequence: 2, observedAt: Date.now() },
        { sessionId: "session-B", projectName: "project-B", phase: "completed", sequence: 4, observedAt: Date.now() },
      ],
    };
    expect((await call("/observations/sessions", token, report)).status).toBe(202);
    expect((await call("/observations/sessions", assistantToken, report)).status).toBe(403);
    expect((await call("/assistant/snapshot", token)).status).toBe(403);
    const snapshot = await call("/assistant/snapshot", assistantToken);
    expect(snapshot.body.settings.chat.enabled).toBe(false);
    expect(snapshot.body.observations[0].sessions.map((row: { phase: string }) => row.phase)).toEqual(["waiting_input", "completed"]);
    const query = async (requestId: string, text: string) => {
      await call("/assistant/chat", assistantToken, { requestId, text });
      let reply = "";
      await vi.waitFor(async () => {
        const state = await call(`/assistant/chat/${requestId}`, assistantToken);
        expect(state.body.status).toBe("completed");
        reply = state.body.message.text;
      });
      return reply;
    };
    const waiting = await query("waiting", "哪个会话在等我？");
    expect(waiting).toContain("session-A");
    expect(waiting).not.toContain("session-B");
    expect(await query("all", "查看会话进度")).toContain("session-B：已完成");
    const { schemaVersion: _, ...settings } = defaultAssistantSettings();
    settings.voice.microphoneEnabled = true;
    settings.voice.asr.enabled = true;
    runtime.assistant.updateSettings(settings);
    const lease = await call("/assistant/voice/acquire", assistantToken, { requestId: "voice-progress", kind: "capture" });
    expect(lease.status).toBe(200);
    const samples = Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / 16000) * 0.15);
    const audio = Buffer.from(captureWave(samples, 16000)).toString("base64");
    const recognized = await call("/assistant/voice/transcribe", assistantToken, { requestId: "voice-progress", leaseId: lease.body.leaseId, audio });
    expect(recognized.body.transcript).toBe("查看進度");
    expect((await call("/assistant/voice/submit", assistantToken, { requestId: "voice-progress", leaseId: lease.body.leaseId })).body.status).toBe("submitted");
    await vi.waitFor(async () => {
      const state = await call("/assistant/chat/voice-progress", assistantToken);
      expect(state.body.status).toBe("completed");
      expect(state.body.message.text).toContain("session-A：等待你回应");
      expect(state.body.message.text).toContain("session-B：已完成");
    });
    await call("/assistant/voice/release", assistantToken, { leaseId: lease.body.leaseId });
    await call("/observations/sessions", token, { ...report, reportSequence: 2, connected: false });
    expect(await query("offline", "哪个会话在等我")).toContain("来源已失联，当前进度不可用");
    expect(provider).not.toHaveBeenCalled();
    expect((await call("/expressions/state", token, { sourceId: report.sourceId, state: "waiting_input" })).status).toBe(202);
    await call(`/clients/${snapshot.body.observations[0].clientId}/revoke`, runtime.rootToken, {});
    expect((await call("/observations/sessions", token, { ...report, reportSequence: 3 })).status).toBe(401);
  } finally {
    await runtime.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
