import type { CallContext, ProviderInfo } from "./chat-provider.js";
export interface VoiceSettings {
  microphoneEnabled: boolean;
  asr: { enabled: boolean; language: "zh" | "en" | "auto" };
  tts: { enabled: boolean; voiceId: string };
}
export function defaultVoiceSettings(): VoiceSettings {
  return {
    microphoneEnabled: false,
    asr: { enabled: false, language: "zh" },
    tts: { enabled: false, voiceId: "" },
  };
}
export interface AudioData {
  bytes: Uint8Array;
  mimeType: string;
  sampleRateHz?: number;
}
export interface SpeechRecognizer {
  info: ProviderInfo;
  transcribe(audio: AudioData, ctx: CallContext): Promise<{ text: string }>;
}
export interface SpeechSynthesizer {
  info: ProviderInfo;
  synthesize(
    input: { text: string; voiceId?: string },
    ctx: CallContext,
  ): Promise<AudioData>;
}
export const VOICE_LEASE_MS = 8000;
export const VOICE_MAX_SAMPLES = 16000 * 30;
export function pcmWaveInfo(
  bytes: Uint8Array,
): { rate: number; channels: number; samples: number; offset: number } | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number, n: number) =>
    String.fromCharCode(...bytes.subarray(at, at + n));
  if (
    tag(0, 4) !== "RIFF" ||
    tag(8, 4) !== "WAVE" ||
    view.getUint32(4, true) !== bytes.length - 8
  )
    return null;
  let format: { rate: number; channels: number } | undefined,
    data: { offset: number; size: number } | undefined;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const size = view.getUint32(at + 4, true),
      start = at + 8;
    if (start + size > bytes.length) return null;
    if (tag(at, 4) === "fmt ") {
      if (
        format ||
        size < 16 ||
        view.getUint16(start, true) !== 1 ||
        view.getUint16(start + 14, true) !== 16
      )
        return null;
      const rate = view.getUint32(start + 4, true),
        channels = view.getUint16(start + 2, true);
      if (
        channels < 1 ||
        channels > 2 ||
        rate < 8000 ||
        rate > 48000 ||
        view.getUint16(start + 12, true) !== channels * 2 ||
        view.getUint32(start + 8, true) !== rate * channels * 2
      )
        return null;
      format = { rate, channels };
    }
    if (tag(at, 4) === "data") {
      if (data) return null;
      data = { offset: start, size };
    }
    at = start + size + (size % 2);
  }
  if (!format || !data || !data.size || data.size % (format.channels * 2))
    return null;
  return {
    ...format,
    samples: data.size / (format.channels * 2),
    offset: data.offset,
  };
}
export function validCaptureWave(bytes: Uint8Array): boolean {
  const info = pcmWaveInfo(bytes);
  if (
    !info ||
    bytes.length > 960044 ||
    info.rate !== 16000 ||
    info.channels !== 1 ||
    info.samples < 4800 ||
    info.samples > VOICE_MAX_SAMPLES
  )
    return false;
  const data = new DataView(
    bytes.buffer,
    bytes.byteOffset + info.offset,
    info.samples * 2,
  );
  let voiced = 0;
  for (let at = 0; at + 160 <= info.samples; at += 160) {
    let power = 0;
    for (let i = 0; i < 160; i++) {
      const sample = data.getInt16((at + i) * 2, true) / 32768;
      power += sample * sample;
    }
    if (Math.sqrt(power / 160) >= 0.008) voiced += 160;
  }
  return voiced >= 4000;
}
/** 面积平均降采样，先限长，再编码为规范 PCM；不包含设备或存储 IO。 */
export function captureWave(samples: Float32Array, rate: number): Uint8Array {
  if (
    !Number.isFinite(rate) ||
    rate < 16000 ||
    rate > 192000 ||
    samples.length > rate * 30
  )
    throw new Error("audio_invalid");
  const count = Math.floor((samples.length * 16000) / rate),
    bytes = new Uint8Array(44 + count * 2),
    view = new DataView(bytes.buffer);
  const tag = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
  };
  tag(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  tag(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const start = (i * rate) / 16000,
      end = ((i + 1) * rate) / 16000;
    let total = 0;
    for (
      let j = Math.floor(start);
      j < Math.ceil(end) && j < samples.length;
      j++
    )
      total +=
        (Number.isFinite(samples[j]) ? samples[j]! : 0) *
        (Math.min(j + 1, end) - Math.max(j, start));
    const value = Math.max(-1, Math.min(1, total / (end - start)));
    view.setInt16(
      44 + i * 2,
      Math.round(value * (value < 0 ? 32768 : 32767)),
      true,
    );
  }
  return bytes;
}
export interface VoiceOwner {
  client: string;
  id: string;
  requestId: string;
  kind: "capture" | "playback";
  epoch: number;
  version: number;
  expires: number;
  blocked: boolean;
}
/** 单调时钟由装配层注入；到期或明确释放前不发放第二份。 */
export class VoiceLease {
  private owner: VoiceOwner | undefined;
  current(now: number): VoiceOwner | undefined {
    if (this.owner && this.owner.expires <= now) this.owner = undefined;
    return this.owner ? { ...this.owner } : undefined;
  }
  acquire(
    input: Omit<VoiceOwner, "expires" | "blocked">,
    now: number,
  ): VoiceOwner | null {
    const old = this.current(now);
    if (old)
      return old.client === input.client &&
        old.requestId === input.requestId &&
        old.kind === input.kind &&
        !old.blocked
        ? old
        : null;
    this.owner = { ...input, expires: now + VOICE_LEASE_MS, blocked: false };
    return { ...this.owner };
  }
  renew(
    client: string,
    id: string,
    kind: VoiceOwner["kind"],
    now: number,
  ): VoiceOwner | null {
    const old = this.current(now);
    if (
      !old ||
      old.client !== client ||
      old.id !== id ||
      old.blocked ||
      (old.kind === "playback" && kind === "capture")
    )
      return null;
    this.owner = { ...old, kind, expires: now + VOICE_LEASE_MS };
    return { ...this.owner };
  }
  invalidate(): void {
    if (this.owner) this.owner.blocked = true;
  }
  release(client: string, id: string): boolean {
    if (this.owner?.client !== client || this.owner.id !== id) return false;
    this.owner = undefined;
    return true;
  }
}
