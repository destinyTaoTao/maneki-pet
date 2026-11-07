import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  VoiceLease,
  VOICE_LEASE_MS,
  validCaptureWave,
  pcmWaveInfo,
  type SpeechRecognizer,
  type SpeechSynthesizer,
  type VoiceOwner,
} from "@maneki-pet/core";
import {
  AssistantError,
  type AssistantSettings,
} from "./assistant-settings.js";
import type { AssistantStore } from "./assistant-store.js";
import type { EventFeed } from "./events.js";
import { WhisperRecognizer } from "./whisper-recognizer.js";
import { WindowsSynthesizer } from "./windows-synthesizer.js";
import { validateObject } from "./validate.js";
export interface VoiceProviders {
  recognizer?: (language: "zh" | "en" | "auto") => SpeechRecognizer;
  synthesizer?: SpeechSynthesizer;
}
export interface VoiceServiceOptions extends VoiceProviders {
  configDir: string;
  store: AssistantStore;
  settings: () => AssistantSettings;
  feed: EventFeed;
  active: (client: string) => boolean;
  chatBusy: () => boolean;
  submit: (client: string, id: string, text: string) => unknown;
  cancelChat: (client: string, id: string) => unknown;
  clock?: () => number;
}
type Job = {
  client: string;
  lease: string;
  requestId?: string;
  controller: AbortController;
  done: Promise<unknown>;
};
const id = (value: unknown) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value))
    throw new AssistantError(400, "voice_request_invalid");
  return value;
};
export class VoiceService {
  private candidate:
    | { client: string; id: string; lease: string; text: string }
    | undefined;
  private readonly lease = new VoiceLease();
  private readonly now: () => number;
  private readonly quarantine: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private job: Job | undefined;
  private stopped = false;
  constructor(private readonly deps: VoiceServiceOptions) {
    this.now = deps.clock ?? (() => performance.now());
    this.quarantine =
      deps.store.get("voiceLeaseActive") === "1"
        ? this.now() + VOICE_LEASE_MS
        : 0;
  }
  private recognizer() {
    return (
      this.deps.recognizer?.(this.deps.settings().voice.asr.language) ??
      new WhisperRecognizer(
        this.deps.configDir,
        this.deps.settings().voice.asr.language,
      )
    );
  }
  private synthesizer() {
    return this.deps.synthesizer ?? new WindowsSynthesizer();
  }
  async status() {
    const recognizer = this.recognizer();
    let voices: Array<{ id: string; culture: string }> = [],
      ttsAvailable = false;
    const synth = this.synthesizer();
    try {
      voices =
        synth instanceof WindowsSynthesizer
          ? await synth.voices({
              requestId: "voices",
              signal: AbortSignal.timeout(5000),
              deadlineAtMs: Date.now() + 5000,
            })
          : [];
      ttsAvailable = true;
    } catch {}
    return {
      asrAvailable: this.deps.recognizer
        ? true
        : recognizer instanceof WhisperRecognizer && recognizer.ready(),
      ttsAvailable,
      voices,
    };
  }
  private enabled(kind: VoiceOwner["kind"]) {
    const voice = this.deps.settings().voice;
    if (kind === "capture" && (!voice.microphoneEnabled || !voice.asr.enabled))
      throw new AssistantError(403, "microphone_disabled");
    if (kind === "playback" && !voice.tts.enabled)
      throw new AssistantError(403, "speech_output_disabled");
  }
  private arm() {
    clearTimeout(this.timer);
    const current = this.lease.current(this.now());
    if (!current) return;
    this.timer = setTimeout(
      () => {
        const holder = this.lease.current(this.now());
        if (holder) {
          this.arm();
          return;
        }
        this.abortJob("voice_lease_expired");
        this.deps.store.set("voiceLeaseActive", "0");
        this.deps.feed.publish("assistant.voice.stop", { leaseId: current.id });
      },
      Math.max(1, current.expires - this.now()),
    );
    this.timer.unref();
  }
  acquire(client: string, raw: Record<string, unknown>) {
    if (
      !validateObject(raw, {
        requestId: { type: "string", required: true, maxLength: 80 },
        kind: {
          type: "string",
          required: true,
          enumValues: ["capture", "playback"],
          maxLength: 8,
        },
      }).ok
    )
      throw new AssistantError(400, "voice_request_invalid");
    if (this.stopped || this.now() < this.quarantine)
      throw new AssistantError(409, "voice_recovering");
    if (this.job) throw new AssistantError(409, "voice_busy");
    const kind = raw.kind as VoiceOwner["kind"];
    this.enabled(kind);
    if (kind === "capture") {
      if (this.deps.chatBusy()) throw new AssistantError(409, "chat_busy");
      const recognizer = this.recognizer();
      if (
        !this.deps.recognizer &&
        recognizer instanceof WhisperRecognizer &&
        !recognizer.ready()
      )
        throw new AssistantError(503, "asr_not_installed");
    }
    const owner = this.lease.acquire(
      {
        client,
        id: randomUUID(),
        requestId: id(raw.requestId),
        kind,
        epoch: this.deps.store.epoch(),
        version: this.deps.settings().version,
      },
      this.now(),
    );
    if (!owner) throw new AssistantError(409, "voice_busy");
    this.deps.store.set("voiceLeaseActive", "1");
    this.arm();
    return {
      leaseId: owner.id,
      ttlMs: Math.max(0, owner.expires - this.now()),
      epoch: owner.epoch,
      settingsVersion: owner.version,
    };
  }
  private owner(
    client: string,
    leaseId: unknown,
    kind?: VoiceOwner["kind"],
  ): VoiceOwner {
    const owner = this.lease.current(this.now());
    if (
      this.stopped ||
      !owner ||
      owner.client !== client ||
      owner.id !== leaseId ||
      owner.blocked ||
      owner.epoch !== this.deps.store.epoch() ||
      owner.version !== this.deps.settings().version ||
      !this.deps.active(client) ||
      (kind && owner.kind !== kind)
    )
      throw new AssistantError(409, "voice_lease_expired");
    this.enabled(owner.kind);
    return owner;
  }
  renew(client: string, raw: Record<string, unknown>) {
    if (
      !validateObject(raw, {
        leaseId: { type: "string", required: true, maxLength: 80 },
        kind: {
          type: "string",
          required: true,
          enumValues: ["capture", "playback"],
          maxLength: 8,
        },
      }).ok
    )
      throw new AssistantError(400, "voice_request_invalid");
    this.owner(client, raw.leaseId);
    this.enabled(raw.kind as VoiceOwner["kind"]);
    const owner = this.lease.renew(
      client,
      String(raw.leaseId),
      raw.kind as VoiceOwner["kind"],
      this.now(),
    );
    if (!owner) throw new AssistantError(409, "voice_lease_expired");
    this.arm();
    return { ttlMs: Math.max(0, owner.expires - this.now()) };
  }
  release(client: string, raw: Record<string, unknown>, cancel = false) {
    if (
      !validateObject(raw, {
        leaseId: { type: "string", required: true, maxLength: 80 },
      }).ok
    )
      throw new AssistantError(400, "voice_request_invalid");
    const current = this.lease.current(this.now());
    if (current?.client !== client || current.id !== raw.leaseId)
      return { released: false };
    if (
      cancel &&
      current.requestId &&
      this.deps.store.request(client, current.requestId)
    )
      this.deps.cancelChat(client, current.requestId);
    this.abortJob("voice_cancelled");
    this.lease.release(client, current.id);
    clearTimeout(this.timer);
    this.deps.store.set("voiceLeaseActive", "0");
    return { released: true };
  }
  private abortJob(code: string) {
    const candidate = this.candidate;
    this.candidate = undefined;
    if (candidate)
      this.deps.store.settleVoiceRequest(
        candidate.client,
        candidate.id,
        "cancelled",
        code,
      );
    const job = this.job;
    if (!job) return;
    job.controller.abort();
    if (job.requestId)
      this.deps.store.settleVoiceRequest(
        job.client,
        job.requestId,
        "cancelled",
        code,
      );
  }
  private waitJob(job: Job): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(new AssistantError(499, "voice_cancelled"));
      };
      const cleanup = () =>
        job.controller.signal.removeEventListener("abort", abort);
      job.done.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
      if (job.controller.signal.aborted) abort();
      else
        job.controller.signal.addEventListener("abort", abort, { once: true });
    });
  }
  invalidate(client?: string) {
    const owner = this.lease.current(this.now());
    if (client && owner?.client !== client) return;
    this.lease.invalidate();
    this.abortJob("voice_cancelled");
    this.deps.feed.publish("assistant.voice.stop", {
      ...(owner ? { leaseId: owner.id } : {}),
    });
  }
  result(client: string, requestId: string) {
    const row = this.deps.store.voiceRequest(client, id(requestId));
    if (!row) throw new AssistantError(404, "voice_request_not_found");
    const chat = this.deps.store.request(client, requestId),
      message = this.deps.store.message(chat?.user_seq ?? null);
    return {
      requestId,
      status: row.status,
      code: row.code,
      transcript:
        message?.text ??
        (row.status === "recognized" &&
        this.candidate?.client === client &&
        this.candidate.id === requestId &&
        this.lease.current(this.now())?.id === this.candidate.lease
          ? this.candidate.text
          : null),
      chat: chat ? { status: chat.status, code: chat.code } : null,
    };
  }
  async transcribe(client: string, raw: Record<string, unknown>) {
    if (
      !validateObject(raw, {
        leaseId: { type: "string", required: true, maxLength: 80 },
        requestId: { type: "string", required: true, maxLength: 80 },
        audio: { type: "string", required: true, maxLength: 1280060 },
      }).ok
    )
      throw new AssistantError(400, "voice_request_invalid");
    const requestId = id(raw.requestId),
      encoded = String(raw.audio);
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded)
      throw new AssistantError(400, "audio_invalid");
    const hash = createHash("sha256").update(bytes).digest("hex"),
      cached = this.deps.store.voiceRequest(client, requestId);
    if (cached) {
      if (cached.hash !== hash)
        throw new AssistantError(409, "request_id_conflict");
      return this.result(client, requestId);
    }
    if (this.deps.store.request(client, requestId))
      throw new AssistantError(409, "request_id_conflict");
    const owner = this.owner(client, raw.leaseId, "capture");
    if (owner.requestId !== requestId)
      throw new AssistantError(409, "voice_request_invalid");
    if (this.job) throw new AssistantError(409, "voice_busy");
    if (!validCaptureWave(bytes))
      throw new AssistantError(422, "audio_silent_or_invalid");
    this.deps.store.createVoiceRequest(client, requestId, hash);
    const controller = new AbortController(),
      job: Job = {
        client,
        lease: owner.id,
        requestId,
        controller,
        done: Promise.resolve(),
      };
    this.job = job;
    job.done = (async () => {
      try {
        const reply = await this.recognizer().transcribe(
          { bytes, mimeType: "audio/wav", sampleRateHz: 16000 },
          {
            requestId,
            signal: controller.signal,
            deadlineAtMs: Date.now() + 45000,
          },
        );
        if (controller.signal.aborted || this.stopped) return;
        this.owner(client, owner.id, "capture");
        if (
          typeof reply.text !== "string" ||
          !reply.text.trim() ||
          reply.text.length > 4000
        )
          throw new AssistantError(422, "transcript_empty");
        this.candidate = {
          client,
          id: requestId,
          lease: owner.id,
          text: reply.text.trim(),
        };
        this.deps.store.settleVoiceRequest(
          client,
          requestId,
          "recognized",
          null,
        );
      } catch (error) {
        if (!this.stopped)
          this.deps.store.settleVoiceRequest(
            client,
            requestId,
            "failed",
            error instanceof AssistantError ? error.code : "speech_failed",
          );
      } finally {
        if (this.job === job) this.job = undefined;
      }
    })();
    await this.waitJob(job).catch((error) => {
      if (
        !(error instanceof AssistantError) ||
        error.code !== "voice_cancelled"
      )
        throw error;
    });
    return this.result(client, requestId);
  }
  submit(client: string, raw: Record<string, unknown>) {
    if (
      !validateObject(raw, {
        leaseId: { type: "string", required: true, maxLength: 80 },
        requestId: { type: "string", required: true, maxLength: 80 },
      }).ok
    )
      throw new AssistantError(400, "voice_request_invalid");
    const requestId = id(raw.requestId),
      row = this.deps.store.voiceRequest(client, requestId);
    if (!row) throw new AssistantError(404, "voice_request_not_found");
    if (["submitted", "cleared", "cancelled", "failed"].includes(row.status))
      return this.result(client, requestId);
    const owner = this.owner(client, raw.leaseId, "capture"),
      candidate = this.candidate;
    if (
      row.status !== "recognized" ||
      !candidate ||
      candidate.client !== client ||
      candidate.id !== requestId ||
      candidate.lease !== owner.id ||
      owner.requestId !== requestId
    )
      throw new AssistantError(409, "voice_request_invalid");
    this.deps.submit(client, requestId, candidate.text);
    this.deps.store.settleVoiceRequest(client, requestId, "submitted", null);
    this.candidate = undefined;
    return this.result(client, requestId);
  }
  async synthesize(client: string, raw: Record<string, unknown>) {
    if (
      !validateObject(raw, {
        leaseId: { type: "string", required: true, maxLength: 80 },
        messageSeq: { type: "number", required: true, min: 1 },
      }).ok ||
      !Number.isSafeInteger(raw.messageSeq)
    )
      throw new AssistantError(400, "voice_request_invalid");
    const owner = this.owner(client, raw.leaseId, "playback"),
      message = this.deps.store.message(raw.messageSeq as number);
    if (!message || message.role !== "assistant")
      throw new AssistantError(404, "speech_message_missing");
    if (this.job) throw new AssistantError(409, "voice_busy");
    const controller = new AbortController(),
      job: Job = {
        client,
        lease: owner.id,
        controller,
        done: Promise.resolve(),
      };
    this.job = job;
    job.done = this.synthesizer()
      .synthesize(
        {
          text: message.text.slice(0, 150),
          voiceId: this.deps.settings().voice.tts.voiceId,
        },
        {
          requestId: `speech-${message.seq}`,
          signal: controller.signal,
          deadlineAtMs: Date.now() + 15000,
        },
      )
      .finally(() => {
        if (this.job === job) this.job = undefined;
      });
    const audio = (await this.waitJob(job)) as Awaited<
      ReturnType<SpeechSynthesizer["synthesize"]>
    >;
    this.owner(client, owner.id, "playback");
    if (controller.signal.aborted)
      throw new AssistantError(499, "voice_cancelled");
    if (
      audio.bytes.length > 2097152 ||
      audio.mimeType !== "audio/wav" ||
      !pcmWaveInfo(audio.bytes)
    )
      throw new AssistantError(502, "speech_audio_invalid");
    return {
      audio: Buffer.from(audio.bytes).toString("base64"),
      mimeType: "audio/wav",
      truncated: message.text.length > 150,
    };
  }
  async stop() {
    this.invalidate();
    this.stopped = true;
    clearTimeout(this.timer);
    const done = this.job?.done;
    if (done)
      await Promise.race([
        done.catch(() => undefined),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 1000);
          timer.unref();
        }),
      ]);
  }
}
