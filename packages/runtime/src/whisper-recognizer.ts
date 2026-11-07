import { statSync } from "node:fs";
import { join } from "node:path";
import type {
  AudioData,
  CallContext,
  SpeechRecognizer,
} from "@maneki-pet/core";
import { AssistantError } from "./assistant-settings.js";
import { speechProcess } from "./speech-process.js";
export class WhisperRecognizer implements SpeechRecognizer {
  readonly info = {
    id: "whisper-cli",
    apiVersion: 1 as const,
    locality: "local" as const,
  };
  private readonly executable: string;
  private readonly model: string;
  constructor(
    configDir: string,
    private readonly language: "zh" | "en" | "auto",
  ) {
    this.executable = join(configDir, "speech/whisper/whisper-cli.exe");
    this.model = join(configDir, "speech/whisper/model.bin");
  }
  ready(): boolean {
    try {
      return (
        process.platform === "win32" &&
        statSync(this.executable).isFile() &&
        statSync(this.model).isFile()
      );
    } catch {
      return false;
    }
  }
  async transcribe(
    audio: AudioData,
    ctx: CallContext,
  ): Promise<{ text: string }> {
    if (!this.ready()) throw new AssistantError(503, "asr_not_installed");
    const version = new TextDecoder()
      .decode(
        await speechProcess(
          this.executable,
          ["--version"],
          new Uint8Array(),
          ctx,
          256,
        ),
      )
      .trim();
    if (!/^whisper\.cpp version: 1\.9\.5(?:-dev)?$/.test(version))
      throw new AssistantError(503, "asr_version_unsupported");
    const result = await speechProcess(
      this.executable,
      [
        "-m",
        this.model,
        "-l",
        this.language,
        "-nt",
        "-np",
        "-ng",
        "-t",
        "4",
        "-of",
        "maneki-stdout-only",
        "-f",
        "-",
      ],
      audio.bytes,
      ctx,
      16384,
    );
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(result)
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
      .trim();
    if (!text || text.length > 4000)
      throw new AssistantError(422, "transcript_empty");
    return { text };
  }
}
