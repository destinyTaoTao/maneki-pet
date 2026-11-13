import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { captureWave } from "@maneki-pet/core";
import { startSpeechHost, type DshSpeechService } from "../../../apps/dsh-plugin/src/speech-host.js";
import { defaultAssistantSettings } from "../src/assistant-settings.js";
import { speechHostTestRuntime } from "./speech-host-test-runtime.js";

it("真实宿主工作者与 Runtime 走完整语音提交链，且失联后文字仍可查询", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maneki-host-plugin-"));
  const runtime = await speechHostTestRuntime(dir);
  const call = async (path: string, token: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${runtime.port}/v1${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() as any };
  };
  let stop: (() => Promise<void>) | undefined;
  try {
    const host = (await call("/pair", runtime.rootToken, { name: "dsh-voice", scopes: "speech_host" })).body;
    const assistant = (await call("/pair", runtime.rootToken, { name: "assistant", scopes: "assistant" })).body;
    const speech: DshSpeechService = {
      snapshot: () => ({ selection: { providerId: "sense" }, providers: [{ id: "sense", location: "host-local", languages: ["zh"], preparation: { phase: "ready" } }] }),
      resolve: (request) => request,
      transcribe: vi.fn(async () => ({ text: "查看进度" })),
    };
    stop = startSpeechHost(new URL(`http://127.0.0.1:${runtime.port}`), host.token, host.clientId, "source", () => speech);
    await vi.waitFor(async () => expect((await call("/assistant/voice/hosts", assistant.token)).body.hosts).toHaveLength(1), { timeout: 5000 });
    const { schemaVersion: _, ...settings } = defaultAssistantSettings();
    settings.voice.microphoneEnabled = true; settings.voice.asr.enabled = true;
    settings.voice.asr.provider = "dsh"; settings.voice.asr.hostClientId = host.clientId; settings.voice.asr.hostSourceId = "source";
    runtime.assistant.updateSettings(settings);
    const lease = (await call("/assistant/voice/acquire", assistant.token, { requestId: "r1", kind: "capture" })).body;
    const audio = Buffer.from(captureWave(Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / 16000) * 0.15), 16000)).toString("base64");
    const result = await call("/assistant/voice/transcribe", assistant.token, { leaseId: lease.leaseId, requestId: "r1", audio });
    expect(result.body.transcript).toBe("查看进度");
    expect(speech.transcribe).toHaveBeenCalledOnce();
    expect((await call("/assistant/voice/submit", assistant.token, { leaseId: lease.leaseId, requestId: "r1" })).body.status).toBe("submitted");
    await call("/assistant/voice/release", assistant.token, { leaseId: lease.leaseId });
    await stop(); stop = undefined;
    await call(`/clients/${host.clientId}/revoke`, runtime.rootToken, {});
    await vi.waitFor(async () => expect((await call("/assistant/chat/r1", assistant.token)).body.status).toBe("completed"));
    expect((await call("/assistant/voice/acquire", assistant.token, { requestId: "r2", kind: "capture" })).body.error).toBe("asr_host_unavailable");
    expect((await call("/assistant/snapshot", assistant.token)).status).toBe(200);
  } finally { await stop?.(); await runtime.stop(); rmSync(dir, { recursive: true, force: true }); }
}, 15000);

it("宿主识别器忽略取消时维持隔离，实际结束后停止确认才放行采集", async () => {
  const dir = mkdtempSync(join(tmpdir(), "maneki-host-uncooperative-"));
  const runtime = await speechHostTestRuntime(dir);
  const call = async (path: string, token: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/v1${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  let resolveSpeech!: (value: { text: string }) => void;
  let stop: (() => Promise<void>) | undefined;
  const delayed = new Promise<{ text: string }>((resolve) => { resolveSpeech = resolve; });
  try {
    const host = (await call("/pair", runtime.rootToken, { name: "worker", scopes: "speech_host" })).body;
    const assistant = (await call("/pair", runtime.rootToken, { name: "assistant", scopes: "assistant" })).body;
    let started = false;
    const speech: DshSpeechService = {
      snapshot: () => ({ selection: { providerId: "sense" }, providers: [{ id: "sense", location: "host-local", languages: ["zh"], preparation: { phase: "ready" } }] }),
      resolve: (request) => request,
      transcribe: () => { started = true; return delayed; },
    };
    stop = startSpeechHost(new URL(`http://127.0.0.1:${runtime.port}`), host.token, host.clientId, "source", () => speech);
    await vi.waitFor(() => expect(runtime.assistant.voice.hosts()).toHaveLength(1), { timeout: 5000 });
    const { schemaVersion: _, ...settings } = defaultAssistantSettings();
    settings.voice.microphoneEnabled = true; settings.voice.asr.enabled = true;
    settings.voice.asr.provider = "dsh"; settings.voice.asr.hostClientId = host.clientId; settings.voice.asr.hostSourceId = "source";
    runtime.assistant.updateSettings(settings);
    const lease = (await call("/assistant/voice/acquire", assistant.token, { requestId: "cancel", kind: "capture" })).body;
    const audio = Buffer.from(captureWave(Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / 16000) * 0.15), 16000)).toString("base64");
    const transcribing = call("/assistant/voice/transcribe", assistant.token, { leaseId: lease.leaseId, requestId: "cancel", audio });
    await vi.waitFor(() => expect(started).toBe(true), { timeout: 5000 });
    await call("/assistant/voice/cancel", assistant.token, { leaseId: lease.leaseId });
    await transcribing;
    expect((await call("/assistant/voice/acquire", assistant.token, { requestId: "blocked", kind: "capture" })).body.error).toBe("voice_host_cleanup_pending");
    resolveSpeech({ text: "查看进度" });
    await vi.waitFor(async () => expect((await call("/assistant/voice/acquire", assistant.token, { requestId: "resumed", kind: "capture" })).body).toHaveProperty("leaseId"), { timeout: 5000 });
  } finally {
    resolveSpeech({ text: "查看进度" });
    await stop?.(); await runtime.stop(); rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
