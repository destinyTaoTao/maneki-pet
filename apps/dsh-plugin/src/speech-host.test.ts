import { expect, it, vi } from "vitest";
import { startSpeechHost, type DshSpeechService } from "./speech-host.js";

it("仅处理登记的本地宿主 Provider，并向 Runtime 交付一次识别结果", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const service: DshSpeechService = {
    snapshot: () => ({ selection: { providerId: "sense" }, providers: [{ id: "sense", location: "host-local", languages: ["zh", "auto"], preparation: { phase: "ready" } }] }),
    resolve: (request) => request,
    transcribe: vi.fn(async () => ({ text: "查看进度" })),
  };
  let first = true;
  const transport = vi.fn(async (_base: URL, _token: string, _client: string, path: string, raw: object) => {
    const body = raw as Record<string, unknown>; calls.push({ path, body });
    if (path === "claim" && first) { first = false; return { job: { jobId: "job", providerId: "sense", audio: "AQI=", language: "zh" } }; }
    return path === "pending" ? { pending: true } : path === "claim" ? { job: null } : { accepted: true };
  });
  const stop = startSpeechHost(new URL("http://127.0.0.1:18100"), "test-token", "client-000000000000", "source", () => service, undefined, transport);
  try {
    await vi.waitFor(() => expect(calls.some((c) => c.path === "complete")).toBe(true));
    expect(calls.find((c) => c.path === "register")?.body).toMatchObject({ sourceId: "source", locality: "local", providerId: "sense" });
    expect(calls.find((c) => c.path === "complete")?.body).toMatchObject({ jobId: "job", text: "查看进度" });
    expect(service.transcribe).toHaveBeenCalledOnce();
  } finally { await stop(); vi.unstubAllGlobals(); }
});

it("云端 Provider 不登记或领取音频", async () => {
  const fetcher = vi.fn(async () => ({}));
  const service: DshSpeechService = { snapshot: () => ({ selection: { providerId: "remote" }, providers: [{ id: "remote", location: "cloud", languages: ["zh"], preparation: { phase: "ready" } }] }), resolve: (r) => r, transcribe: vi.fn() };
  const stop = startSpeechHost(new URL("http://127.0.0.1:18100"), "test-token", "client-000000000000", "source", () => service, undefined, fetcher);
  try { await new Promise((resolve) => setTimeout(resolve, 20)); expect(fetcher).not.toHaveBeenCalled(); }
  finally { await stop(); vi.unstubAllGlobals(); }
});

it("本地 Provider 首次唤醒期间维持可用，避免取消正在识别的录音", async () => {
  let phase = "standby", first = true;
  const registrations: boolean[] = [];
  const service: DshSpeechService = {
    snapshot: () => ({ selection: { providerId: "sense" }, providers: [{ id: "sense", location: "host-local", languages: ["zh"], preparation: { phase } }] }),
    resolve: (request) => request,
    transcribe: async () => { phase = "waking"; await new Promise((resolve) => setTimeout(resolve, 1200)); phase = "ready"; return { text: "查看进度" }; },
  };
  const transport = vi.fn(async (_base: URL, _token: string, _client: string, path: string, raw: object) => {
    const body = raw as Record<string, unknown>;
    if (path === "register") registrations.push(body.ready as boolean);
    if (path === "claim" && first) { first = false; return { job: { jobId: "job", providerId: "sense", audio: "AQI=", language: "zh" } }; }
    return path === "pending" ? { pending: true } : path === "claim" ? { job: null } : { accepted: true };
  });
  const stop = startSpeechHost(new URL("http://127.0.0.1:18100"), "token", "client-000000000000", "source", () => service, undefined, transport);
  try { await vi.waitFor(() => expect(registrations.length).toBeGreaterThan(1), { timeout: 3000 }); expect(registrations).not.toContain(false); }
  finally { await stop(); vi.unstubAllGlobals(); }
});
