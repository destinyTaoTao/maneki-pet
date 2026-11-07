import { join } from "node:path";
import {
  pcmWaveInfo,
  type AudioData,
  type CallContext,
  type SpeechSynthesizer,
} from "@maneki-pet/core";
import { AssistantError } from "./assistant-settings.js";
import { speechProcess } from "./speech-process.js";
const SCRIPT = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$s=[System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  $data=[Console]::In.ReadToEnd()|ConvertFrom-Json
  if ($data.mode -eq 'voices') {
    $voices=@($s.GetInstalledVoices()|Where-Object {$_.Enabled}|ForEach-Object {@{id=$_.VoiceInfo.Name;culture=$_.VoiceInfo.Culture.Name}})
    [Console]::OutputEncoding=[Text.Encoding]::UTF8
    [Console]::Write((ConvertTo-Json -InputObject $voices -Compress)); exit
  }
  if ($data.voiceId) { $s.SelectVoice([string]$data.voiceId) }
  $stream=[IO.MemoryStream]::new()
  try {
    $s.SetOutputToWaveStream($stream)
    $s.Speak([string]$data.text)
    if ($stream.Length -gt 2097152) { throw 'speech output limit' }
    $bytes=$stream.ToArray()
    $output=[Console]::OpenStandardOutput(); $output.Write($bytes,0,$bytes.Length); $output.Flush()
  } finally { $stream.Dispose() }
} finally { $s.Dispose() }
`;
export class WindowsSynthesizer implements SpeechSynthesizer {
  readonly info = {
    id: "windows-system-speech",
    apiVersion: 1 as const,
    locality: "local" as const,
  };
  private call(input: unknown, ctx: CallContext, max: number) {
    if (process.platform !== "win32")
      throw new AssistantError(503, "speech_unsupported");
    return speechProcess(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", SCRIPT],
      Buffer.from(JSON.stringify(input)),
      ctx,
      max,
    );
  }
  async voices(
    ctx: CallContext,
  ): Promise<Array<{ id: string; culture: string }>> {
    const data = await this.call({ mode: "voices" }, ctx, 16384);
    let values: unknown;
    try {
      values = JSON.parse(new TextDecoder().decode(data));
    } catch {
      throw new AssistantError(502, "speech_failed");
    }
    if (
      !Array.isArray(values) ||
      values.length > 100 ||
      values.some(
        (v) => !v || typeof v.id !== "string" || typeof v.culture !== "string",
      )
    )
      throw new AssistantError(502, "speech_failed");
    return values as Array<{ id: string; culture: string }>;
  }
  async synthesize(
    input: { text: string; voiceId?: string },
    ctx: CallContext,
  ): Promise<AudioData> {
    if (!input.text.trim() || input.text.length > 150)
      throw new AssistantError(400, "speech_text_invalid");
    const bytes = await this.call(input, ctx, 2097152);
    if (!pcmWaveInfo(bytes))
      throw new AssistantError(502, "speech_audio_invalid");
    return { bytes, mimeType: "audio/wav" };
  }
}
