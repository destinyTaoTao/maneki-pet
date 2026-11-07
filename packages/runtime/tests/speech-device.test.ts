import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureWave, pcmWaveInfo, validCaptureWave } from "@maneki-pet/core";
import { startRuntime } from "../src/runtime.js";
import { defaultAssistantSettings } from "../src/assistant-settings.js";
import { expect, it } from "vitest";
import { WindowsSynthesizer } from "../src/windows-synthesizer.js";
import { WhisperRecognizer } from "../src/whisper-recognizer.js";
it.skipIf(
  process.platform !== "win32" ||
    !process.env.MANEKI_WHISPER_TEST_DIR ||
    !process.env.MANEKI_WHISPER_TEST_MODEL,
)(
  "真实本地 TTS→内存 WAV→whisper.cpp stdin 转写，取消后回收进程",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "maneki-speech-device-")),
      engine = join(dir, "speech/whisper");
    mkdirSync(engine, { recursive: true });
    try {
      for (const name of readdirSync(process.env.MANEKI_WHISPER_TEST_DIR!))
        if (/\.(exe|dll)$/i.test(name))
          copyFileSync(
            join(process.env.MANEKI_WHISPER_TEST_DIR!, name),
            join(engine, name),
          );
      cpSync(process.env.MANEKI_WHISPER_TEST_MODEL!, join(engine, "model.bin"));
      const synth = new WindowsSynthesizer(),
        ctx = () => ({
          requestId: "device",
          signal: new AbortController().signal,
          deadlineAtMs: Date.now() + 45000,
        });
      const voices = await synth.voices(ctx());
      expect(voices.length).toBeGreaterThan(0);
      const chinese = voices.find((voice) => voice.culture === "zh-CN");
      expect(chinese).toBeDefined();
      const speech = await synth.synthesize(
          { text: "添加待办，买牛奶。", voiceId: chinese!.id },
          ctx(),
        ),
        info = pcmWaveInfo(speech.bytes)!;
      expect(info.channels).toBe(1);
      const input = new Float32Array(info.samples),
        data = new DataView(
          speech.bytes.buffer,
          speech.bytes.byteOffset + info.offset,
          info.samples * 2,
        );
      for (let i = 0; i < input.length; i++)
        input[i] = data.getInt16(i * 2, true) / 32768;
      const wav = captureWave(input, info.rate),
        recognizer = new WhisperRecognizer(dir, "zh"),
        start = performance.now(),
        before = readdirSync(engine).sort();
      expect(validCaptureWave(wav)).toBe(true);
      const result = await recognizer.transcribe(
        { bytes: wav, mimeType: "audio/wav", sampleRateHz: 16000 },
        ctx(),
      );
      console.info(
        JSON.stringify({
          device: "whisper.cpp",
          elapsedMs: Math.round(performance.now() - start),
          transcript: result.text,
        }),
      );
      expect(result.text).toMatch(/牛奶/);
      expect(readdirSync(engine).sort()).toEqual(before);
      const runtime = await startRuntime({ configDir: dir });
      try {
        const { schemaVersion: _, ...settings } = defaultAssistantSettings();
        settings.voice.microphoneEnabled = true;
        settings.voice.asr.enabled = true;
        runtime.assistant.updateSettings(settings);
        const lease = runtime.assistant.voice.acquire("root", {
          requestId: "native-flow",
          kind: "capture",
        });
        const recognized = await runtime.assistant.voice.transcribe("root", {
          leaseId: lease.leaseId,
          requestId: "native-flow",
          audio: Buffer.from(wav).toString("base64"),
        });
        expect(recognized.status).toBe("recognized");
        expect(runtime.assistant.snapshot().messages).toEqual([]);
        expect(
          runtime.assistant.voice.submit("root", {
            leaseId: lease.leaseId,
            requestId: "native-flow",
          }).status,
        ).toBe("submitted");
        expect(runtime.assistant.snapshot().messages[0]?.text).toMatch(/牛奶/);
      } finally {
        await runtime.stop();
      }
      const controller = new AbortController(),
        pending = recognizer.transcribe(
          { bytes: wav, mimeType: "audio/wav" },
          { ...ctx(), signal: controller.signal },
        );
      const timer = setTimeout(() => controller.abort(), 100);
      await expect(pending).rejects.toMatchObject({ code: "voice_cancelled" });
      clearTimeout(timer);
      expect(
        readdirSync(dir).filter((name) => /wav|pcm|audio/i.test(name)),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60000,
);
