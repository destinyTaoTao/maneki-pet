import {
  pcmWaveInfo,
  validCaptureWave,
  type AudioData,
  type CallContext,
  type SpeechRecognizer,
  type SpeechSynthesizer,
  type VoiceSettings,
} from "@maneki-pet/core";
import { AssistantError } from "./assistant-settings.js";

type Config = NonNullable<VoiceSettings["bailian"]>;
const record = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
function endpoint(config: Config) {
  if (!/^[A-Za-z0-9-]{0,64}$/.test(config.workspaceId))
    throw new AssistantError(400, "voice_settings_invalid");
  return config.workspaceId
    ? `https://${config.workspaceId}.cn-beijing.maas.aliyuncs.com`
    : "https://dashscope.aliyuncs.com";
}
function cancelled(ctx: CallContext, signal: AbortSignal) {
  if (signal.aborted)
    throw new AssistantError(
      499,
      ctx.signal.aborted ? "voice_cancelled" : "speech_timeout",
    );
}
function signalFor(ctx: CallContext) {
  return AbortSignal.any([
    ctx.signal,
    AbortSignal.timeout(Math.max(1, ctx.deadlineAtMs - Date.now())),
  ]);
}
async function bytes(
  url: string,
  init: RequestInit,
  max: number,
  ctx: CallContext,
  signal: AbortSignal,
): Promise<Uint8Array> {
  cancelled(ctx, signal);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const abort = () => {
    void reader?.cancel().catch(() => undefined);
  };
  try {
    const response = await fetch(url, { ...init, signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AssistantError(
        502,
        response.status === 401 || response.status === 403
          ? "speech_auth_failed"
          : "speech_failed",
      );
    }
    reader = response.body?.getReader();
    if (!reader) throw new AssistantError(502, "speech_invalid_response");
    signal.addEventListener("abort", abort, { once: true });
    cancelled(ctx, signal);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      cancelled(ctx, signal);
      if (part.done) break;
      size += part.value.length;
      if (size > max) throw new AssistantError(502, "speech_output_limit");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    cancelled(ctx, signal);
    throw error instanceof AssistantError
      ? error
      : new AssistantError(502, "speech_unavailable");
  } finally {
    signal.removeEventListener("abort", abort);
    await reader?.cancel().catch(() => undefined);
  }
}
async function json(
  url: string,
  body: unknown,
  key: string,
  max: number,
  ctx: CallContext,
  signal: AbortSignal,
) {
  const data = await bytes(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    },
    max,
    ctx,
    signal,
  );
  try {
    return record(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)),
    );
  } catch {
    throw new AssistantError(502, "speech_invalid_response");
  }
}
/** 只接受官方北京结果桶；不转发 API 凭证、明文请求或重定向。 */
function audioUrl(raw: unknown): string {
  try {
    if (typeof raw !== "string" || raw.length > 4096) throw new Error();
    const url = new URL(raw);
    if (
      url.hostname !== "dashscope-result-bj.oss-cn-beijing.aliyuncs.com" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !["http:", "https:"].includes(url.protocol) ||
      !url.pathname.endsWith(".wav")
    )
      throw new Error();
    url.protocol = "https:";
    return url.href;
  } catch {
    throw new AssistantError(502, "speech_audio_url_invalid");
  }
}
export class BailianRecognizer implements SpeechRecognizer {
  readonly info = {
    id: "bailian-asr",
    apiVersion: 1 as const,
    locality: "cloud" as const,
  };
  constructor(
    private readonly config: Config,
    private readonly key: string,
    private readonly language: "zh" | "en" | "auto",
  ) {}
  async transcribe(audio: AudioData, ctx: CallContext) {
    if (audio.mimeType !== "audio/wav" || !validCaptureWave(audio.bytes))
      throw new AssistantError(400, "audio_invalid");
    const signal = signalFor(ctx);
    const root = await json(
      `${endpoint(this.config)}/compatible-mode/v1/chat/completions`,
      {
        model: this.config.asrModel,
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: {
                  data: `data:audio/wav;base64,${Buffer.from(audio.bytes).toString("base64")}`,
                },
              },
            ],
          },
        ],
        asr_options: {
          enable_itn: false,
          ...(this.language !== "auto" ? { language: this.language } : {}),
        },
      },
      this.key,
      262144,
      ctx,
      signal,
    );
    const choice = record(
        Array.isArray(root.choices) ? root.choices[0] : undefined,
      ),
      text = record(choice.message).content;
    if (
      choice.finish_reason !== "stop" ||
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 4000
    )
      throw new AssistantError(502, "speech_invalid_response");
    cancelled(ctx, signal);
    return { text: text.trim() };
  }
}
export class BailianSynthesizer implements SpeechSynthesizer {
  readonly info = {
    id: "bailian-tts",
    apiVersion: 1 as const,
    locality: "cloud" as const,
  };
  constructor(
    private readonly config: Config,
    private readonly key: string,
  ) {}
  async synthesize(
    input: { text: string; voiceId?: string },
    ctx: CallContext,
  ): Promise<AudioData> {
    if (!input.text.trim() || input.text.length > 150)
      throw new AssistantError(400, "speech_text_invalid");
    const signal = signalFor(ctx);
    const root = await json(
      `${endpoint(this.config)}/api/v1/services/aigc/multimodal-generation/generation`,
      {
        model: this.config.ttsModel,
        input: {
          text: input.text,
          voice: this.config.voiceId,
          language_type: "Auto",
        },
      },
      this.key,
      65536,
      ctx,
      signal,
    );
    const output = record(root.output);
    if (
      (root.code && root.code !== "") ||
      (root.status_code !== undefined && root.status_code !== 200) ||
      output.finish_reason !== "stop"
    )
      throw new AssistantError(502, "speech_invalid_response");
    const result = await bytes(
      audioUrl(record(output.audio).url),
      { method: "GET" },
      2097152,
      ctx,
      signal,
    );
    if (!pcmWaveInfo(result))
      throw new AssistantError(502, "speech_audio_invalid");
    return { bytes: result, mimeType: "audio/wav" };
  }
}
