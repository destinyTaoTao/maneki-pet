import { randomBytes } from "node:crypto";
import { speechHostRequest } from "./speech-transport.js";

export interface DshSpeechService {
  snapshot(): { selection: { providerId: string }; providers: Array<{ id: string; location: string; languages: readonly string[]; preparation: { phase: string } }> };
  resolve(request: { audio: Uint8Array; language: string; providerId: string }): unknown;
  transcribe(spec: unknown, signal: AbortSignal): Promise<{ text: string }>;
}

/** 可选宿主语音工作者；只处理经用户授权且发给本实例的单次工作。 */
export function startSpeechHost(base: URL, token: string, clientId: string, sourceId: string, service: () => DshSpeechService | undefined, sourceSecret = randomBytes(32).toString("base64url"), transport = speechHostRequest): () => Promise<void> {
  const life = new AbortController();
  let busy = false;
  let activeWork: Promise<void> | undefined;
  const request = (path: string, body: object, signal: AbortSignal) => transport(base, token, clientId, path, body, signal);
  const signal = () => AbortSignal.any([life.signal, AbortSignal.timeout(2500)]);
  const registration = async () => {
    const speech = service(); if (!speech) return false;
    const snapshot = speech.snapshot(), provider = snapshot.providers.find((p) => p.id === snapshot.selection.providerId);
    if (!provider || provider.location !== "host-local") return false;
    const languages = provider.languages.filter((v) => ["zh", "en", "auto"].includes(v));
    // dsh 在首个识别请求唤醒 worker 时允许有界排队；不能把 waking 误报成离线。
    const ready = ["ready", "standby", "waking"].includes(provider.preparation.phase);
    await request("register", { protocolVersion: 1, sourceId, sourceSecret, providerId: provider.id, locality: "local", languages, ready }, signal());
    return ready;
  };
  const work = async () => {
    if (busy || life.signal.aborted) return;
    const speech = service(); if (!speech) return;
    busy = true;
    try {
      const response = await request("claim", { sourceId, sourceSecret }, signal());
      if (!response.job) return;
      const job = response.job as Record<string, unknown>;
      if (typeof job.jobId !== "string" || typeof job.audio !== "string" || job.audio.length > 1280060 || typeof job.language !== "string" || typeof job.providerId !== "string") return;
      const snapshot = speech.snapshot(), provider = snapshot.providers.find((p) => p.id === snapshot.selection.providerId);
      if (!provider || provider.location !== "host-local" || provider.id !== job.providerId) {
        await request("complete", { sourceId, sourceSecret, jobId: job.jobId, failed: true }, signal()).catch(() => undefined);
        await request("ack", { sourceId, sourceSecret, jobId: job.jobId }, AbortSignal.timeout(2500)).catch(() => undefined);
        return;
      }
      const controller = new AbortController();
      const stop = () => controller.abort(); life.signal.addEventListener("abort", stop, { once: true });
      let checking = false;
      const poll = setInterval(() => {
        if (checking) return; checking = true;
        void request("pending", { sourceId, sourceSecret, jobId: job.jobId }, signal()).then((r) => { if (r.pending !== true) controller.abort(); }).catch(() => controller.abort()).finally(() => { checking = false; });
      }, 500);
      poll.unref();
      try {
        const bytes = Buffer.from(job.audio, "base64");
        if (bytes.toString("base64") !== job.audio) throw new Error("invalid audio");
        const result = await speech.transcribe(speech.resolve({ audio: bytes, language: job.language, providerId: provider.id }), controller.signal);
        if (!controller.signal.aborted) await request("complete", { sourceId, sourceSecret, jobId: job.jobId, text: result.text }, signal());
      } catch {
        if (!controller.signal.aborted) await request("complete", { sourceId, sourceSecret, jobId: job.jobId, failed: true }, signal()).catch(() => undefined);
      } finally {
        clearInterval(poll); life.signal.removeEventListener("abort", stop);
        // 识别已实际结束；即使取消与结果交错，也须确认停止，不能依赖轮询已观察到取消。
        await request("ack", { sourceId, sourceSecret, jobId: job.jobId }, AbortSignal.timeout(2500)).catch(() => undefined);
      }
    } finally { busy = false; }
  };
  const tick = () => { void registration().then((ready) => {
    if (!ready || busy || life.signal.aborted) return;
    const pending = work(); activeWork = pending;
    void pending.catch(() => undefined).finally(() => { if (activeWork === pending) activeWork = undefined; });
  }).catch(() => undefined); };
  const timer = setInterval(tick, 1000); timer.unref(); tick();
  return async () => {
    clearInterval(timer); life.abort();
    // 受信 dsh 服务应响应取消；若服务未配合，停止等待并隔离迟到结果。
    if (activeWork) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([activeWork.catch(() => undefined), new Promise<void>((resolve) => { timeout = setTimeout(resolve, 2500); timeout.unref(); })]); }
      finally { clearTimeout(timeout); }
    }
  };
}
