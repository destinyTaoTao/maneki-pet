import type { VoiceCapture, VoicePlayer } from "./voice-media.js";
export type VoicePhase =
  | "idle"
  | "starting"
  | "recording"
  | "transcribing"
  | "waiting"
  | "speaking";
export interface VoiceResult {
  requestId: string;
  status: string;
  code: string | null;
  transcript: string | null;
}
export interface VoiceTransport {
  call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
}
export class VoiceController {
  private phase: VoicePhase = "idle";
  private generation = 0;
  private lease: string | undefined;
  private capture: VoiceCapture | undefined;
  private renew: ReturnType<typeof setTimeout> | undefined;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private limit: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private kind: "capture" | "playback" = "capture";
  private renewing: Promise<void> | undefined;
  constructor(
    private readonly deps: {
      transport: VoiceTransport;
      capture: () => VoiceCapture;
      player: VoicePlayer;
      changed: (phase: VoicePhase) => void;
      error: (code: string) => void;
      submitted: (result: VoiceResult) => void;
      recognized?: (text: string) => void;
      now?: () => number;
      uuid?: () => string;
    },
  ) {}
  state() {
    return this.phase;
  }
  ownsRequest(id: string) {
    return this.requestId === id;
  }
  stopIfOwned(leaseId: unknown) {
    if (typeof leaseId === "string" && this.lease && leaseId === this.lease)
      void this.cancel(false, "voice_lease_expired");
  }
  private set(phase: VoicePhase) {
    this.phase = phase;
    this.deps.changed(phase);
  }
  private deadline(ttl: number, started: number, generation: number) {
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 8000)
      throw new Error("voice_lease_expired");
    clearTimeout(this.expiry);
    const left =
      ttl - ((this.deps.now?.() ?? performance.now()) - started) - 100;
    if (left <= 0) {
      void this.cancel(false, "voice_lease_expired");
      throw new Error("voice_lease_expired");
    }
    this.expiry = setTimeout(() => {
      if (generation === this.generation)
        void this.cancel(false, "voice_lease_expired");
    }, left);
  }
  private heartbeat(generation: number) {
    clearTimeout(this.renew);
    this.renew = setTimeout(() => {
      if (generation !== this.generation || !this.lease) return;
      const started = this.deps.now?.() ?? performance.now();
      this.renewing = this.deps.transport
        .call<{ ttlMs: number }>(
          "/voice/renew",
          { leaseId: this.lease, kind: this.kind },
          this.controller?.signal,
        )
        .then((result) => {
          if (generation !== this.generation) return;
          this.deadline(result.ttlMs, started, generation);
          this.heartbeat(generation);
        })
        .catch(() => {
          if (generation === this.generation)
            void this.cancel(false, "voice_lease_expired");
        });
    }, 2000);
  }
  private async acquire(kind: "capture" | "playback", generation: number) {
    const started = this.deps.now?.() ?? performance.now(),
      requestId = this.deps.uuid?.() ?? crypto.randomUUID();
    const result = await this.deps.transport.call<{
      leaseId: string;
      ttlMs: number;
    }>("/voice/acquire", { kind, requestId }, this.controller?.signal);
    if (generation !== this.generation) {
      void this.deps.transport
        .call("/voice/release", { leaseId: result.leaseId })
        .catch(() => undefined);
      throw new Error("voice_cancelled");
    }
    this.lease = result.leaseId;
    this.kind = kind;
    this.deadline(result.ttlMs, started, generation);
    this.heartbeat(generation);
    return requestId;
  }
  async start() {
    if (["starting", "recording", "transcribing"].includes(this.phase)) return;
    const cleanup = this.cancel(false);
    const generation = ++this.generation;
    this.controller = new AbortController();
    this.set("starting");
    this.limit = setTimeout(() => {
      if (generation === this.generation)
        void this.cancel(false, "microphone_unavailable");
    }, 30000);
    try {
      await cleanup;
      if (generation !== this.generation) return;
      const requestId = await this.acquire("capture", generation);
      if (generation !== this.generation) return;
      const capture = this.deps.capture();
      this.capture = capture;
      await capture.start();
      if (generation !== this.generation) {
        await capture.cancel();
        return;
      }
      this.requestId = requestId;
      this.set("recording");
      clearTimeout(this.limit);
      this.limit = setTimeout(() => void this.finish(), 30000);
    } catch (error) {
      if (generation === this.generation) await this.fail(error);
    }
  }
  private requestId: string | undefined;
  async finish() {
    if (this.phase === "starting") {
      await this.cancel(false);
      return;
    }
    if (
      this.phase !== "recording" ||
      !this.capture ||
      !this.lease ||
      !this.requestId
    )
      return;
    const generation = this.generation;
    clearTimeout(this.limit);
    this.set("transcribing");
    try {
      const bytes = await this.capture.finish();
      this.capture = undefined;
      if (generation !== this.generation) return;
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      let result = await this.deps.transport.call<VoiceResult>(
        "/voice/transcribe",
        { leaseId: this.lease, requestId: this.requestId, audio: btoa(binary) },
        this.controller?.signal,
      );
      if (generation !== this.generation) return;
      if (result.status === "recognized") {
        if (!result.transcript?.trim()) throw new Error("transcript_empty");
        this.deps.recognized?.(result.transcript);
        if (generation !== this.generation) return;
        result = await this.deps.transport.call<VoiceResult>(
          "/voice/submit",
          { leaseId: this.lease, requestId: this.requestId },
          this.controller?.signal,
        );
        if (generation !== this.generation) return;
      }
      if (result.status !== "submitted")
        throw new Error(result.code ?? "speech_failed");
      this.set("waiting");
      this.deps.submitted(result);
    } catch (error) {
      if (generation === this.generation) await this.fail(error);
    }
  }
  async speak(messageSeq: number) {
    if (
      this.phase === "recording" ||
      this.phase === "starting" ||
      this.phase === "transcribing"
    )
      return;
    const continuing = this.phase === "waiting" && Boolean(this.lease),
      cleanup = continuing ? Promise.resolve() : this.cancel(false);
    const generation = continuing ? this.generation : ++this.generation;
    this.controller ??= new AbortController();
    try {
      await cleanup;
      if (generation !== this.generation) return;
      if (!this.lease) await this.acquire("playback", generation);
      else {
        clearTimeout(this.renew);
        await this.renewing;
        if (generation !== this.generation) return;
        clearTimeout(this.renew);
        const started = this.deps.now?.() ?? performance.now();
        const result = await this.deps.transport.call<{ ttlMs: number }>(
          "/voice/renew",
          { leaseId: this.lease, kind: "playback" },
          this.controller.signal,
        );
        if (generation !== this.generation) return;
        this.kind = "playback";
        this.deadline(result.ttlMs, started, generation);
        this.heartbeat(generation);
      }
      if (generation !== this.generation) return;
      this.set("speaking");
      const result = await this.deps.transport.call<{
        audio: string;
        truncated: boolean;
      }>(
        "/voice/synthesize",
        { leaseId: this.lease, messageSeq },
        this.controller.signal,
      );
      if (generation !== this.generation) return;
      const binary = atob(result.audio);
      if (binary.length > 2097152) throw new Error("speech_audio_invalid");
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      if (result.truncated) this.deps.error("speech_truncated");
      await this.deps.player.play(bytes);
      if (generation === this.generation) await this.cancel(false);
    } catch (error) {
      if (generation === this.generation) await this.fail(error);
    }
  }
  async complete() {
    await this.cancel(false);
  }
  async cancel(cancelChat = true, reason?: string) {
    this.renewing = undefined;
    ++this.generation;
    clearTimeout(this.renew);
    clearTimeout(this.expiry);
    clearTimeout(this.limit);
    this.controller?.abort();
    this.controller = undefined;
    const capture = this.capture;
    this.capture = undefined;
    const lease = this.lease;
    this.lease = undefined;
    this.requestId = undefined;
    this.deps.player.stop();
    this.set("idle");
    await capture?.cancel().catch(() => undefined);
    if (lease)
      await this.deps.transport
        .call(cancelChat ? "/voice/cancel" : "/voice/release", {
          leaseId: lease,
        })
        .catch(() => undefined);
    if (reason) this.deps.error(reason);
  }
  private async fail(error: unknown) {
    const message = error instanceof Error ? error.message : "";
    let code =
      error instanceof Error && error.name === "NotAllowedError"
        ? "microphone_denied"
        : error instanceof Error &&
            [
              "NotFoundError",
              "NotReadableError",
              "OverconstrainedError",
              "SecurityError",
            ].includes(error.name)
          ? "microphone_unavailable"
          : /^[a-z][a-z_]{1,80}$/.test(message)
            ? message
            : "speech_failed";
    if (
      this.phase === "transcribing" &&
      ["runtime_unavailable", "invalid_response"].includes(code)
    )
      code = "speech_result_unknown";
    await this.cancel(false);
    this.deps.error(code);
  }
}
