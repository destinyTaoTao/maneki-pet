import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureWave, defaultBailianSettings } from "@maneki-pet/core";
import { startRuntime, type StartedRuntime } from "../src/runtime.js";
import {
  readAssistantSettings,
  readSpeechKey,
  settingsView,
} from "../src/assistant-settings.js";
import { AssistantStore } from "../src/assistant-store.js";
let dir: string, runtime: StartedRuntime | undefined;
afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});
async function setup() {
  dir = mkdtempSync(join(tmpdir(), "maneki-cloud-voice-"));
  runtime = await startRuntime({ configDir: dir });
  return runtime;
}
function input(r: StartedRuntime) {
  const {
    schemaVersion: _,
    speechApiKeyRef: __,
    chat: { apiKeyRef: ___, ...chat },
    ...settings
  } = readAssistantSettings(r.store.assistantStore());
  return { ...settings, chat };
}
function online(r: StartedRuntime) {
  const settings = input(r);
  return {
    ...settings,
    cloudEnabled: true,
    speechApiKey: "speech-test-secret",
    voice: {
      microphoneEnabled: true,
      asr: {
        enabled: true,
        language: "zh" as const,
        provider: "bailian" as const,
      },
      tts: { enabled: true, voiceId: "", provider: "bailian" as const },
      bailian: defaultBailianSettings(),
    },
  };
}
const wav = () =>
  captureWave(
    Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 5) * 0.2),
    16000,
  );
it("云端关/无独立密钥时不开麦，检测不联网；旧设置保留选项与密钥，删除不影响对话密钥", async () => {
  const r = await setup(),
    fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  r.assistant.updateSettings({
    ...online(r),
    cloudEnabled: false,
    apiKey: "chat-test-secret",
  });
  expect(() =>
    r.assistant.voice.acquire("root", {
      kind: "capture",
      requestId: "disabled",
    }),
  ).toThrow("cloud_disabled");
  expect((await r.assistant.voice.status()).asrAvailable).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
  r.assistant.updateSettings({
    ...input(r),
    voice: {
      ...readAssistantSettings(r.store.assistantStore()).voice,
      tts: { enabled: true, voiceId: "", provider: "local" },
    },
  });
  const localPlayback = r.assistant.voice.acquire("root", {
    kind: "playback",
    requestId: "local-read",
  });
  expect(localPlayback.leaseId).toBeTruthy();
  r.assistant.voice.release("root", { leaseId: localPlayback.leaseId });
  const visible = settingsView(readAssistantSettings(r.store.assistantStore()));
  expect(visible.voice.apiKeyConfigured).toBe(true);
  expect(JSON.stringify(visible)).not.toMatch(
    /speech-test-secret|chat-test-secret|ApiKeyRef|assistant-speech-key/,
  );
  const { voice: _, ...old } = input(r);
  r.assistant.updateSettings({ ...old, cloudEnabled: true });
  const saved = readAssistantSettings(r.store.assistantStore());
  expect(saved.voice.asr.provider).toBe("bailian");
  expect(readSpeechKey(dir, saved)).toBe("speech-test-secret");
  const localShape = {
    microphoneEnabled: true,
    asr: { enabled: true, language: "zh" },
    tts: { enabled: true, voiceId: "" },
  };
  r.assistant.updateSettings({ ...input(r), voice: localShape });
  expect(
    readAssistantSettings(r.store.assistantStore()).voice.asr.provider,
  ).toBe("bailian");
  expect((await r.assistant.voice.status()).configurationOnly).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  r.assistant.updateSettings({ ...input(r), speechApiKey: "" });
  expect(() =>
    r.assistant.voice.acquire("root", { kind: "capture", requestId: "no-key" }),
  ).toThrow("speech_key_missing");
  const keys = readdirSync(dir).filter((name) => name.startsWith("assistant-"));
  expect(keys).toHaveLength(1);
  expect(readFileSync(join(dir, keys[0]!), "utf8")).toBe("chat-test-secret");
});
it("官方协议接入主会话与待办，显式云端选择不要求安装本地模型", async () => {
  const r = await setup();
  r.assistant.updateSettings(online(r));
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [
          { finish_reason: "stop", message: { content: "待办：买牛奶" } },
        ],
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const lease = r.assistant.voice.acquire("root", {
    kind: "capture",
    requestId: "cloud-round",
  });
  expect(
    (
      await r.assistant.voice.transcribe("root", {
        leaseId: lease.leaseId,
        requestId: "cloud-round",
        audio: Buffer.from(wav()).toString("base64"),
      })
    ).status,
  ).toBe("recognized");
  expect(r.assistant.snapshot().todos).toEqual([]);
  expect(
    r.assistant.voice.submit("root", {
      leaseId: lease.leaseId,
      requestId: "cloud-round",
    }).status,
  ).toBe("submitted");
  expect(r.assistant.snapshot().todos[0]?.title).toBe("买牛奶");
  expect(fetcher).toHaveBeenCalledTimes(1);
  r.assistant.voice.release("root", { leaseId: lease.leaseId });
  const message = r.assistant
    .snapshot()
    .messages.find((m) => m.role === "assistant")!;
  fetcher
    .mockReset()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: {
            finish_reason: "stop",
            audio: {
              url: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.wav",
            },
          },
        }),
      ),
    )
    .mockResolvedValueOnce(new Response(wav()));
  const playback = r.assistant.voice.acquire("root", {
    kind: "playback",
    requestId: "read",
  });
  expect(
    (
      await r.assistant.voice.synthesize("root", {
        leaseId: playback.leaseId,
        messageSeq: message.seq,
      })
    ).mimeType,
  ).toBe("audio/wav");
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("关闭云端中止在途上传并拒绝迟到文本，重新启用不重放请求", async () => {
  const r = await setup();
  r.assistant.updateSettings(online(r));
  let resolve: ((value: Response) => void) | undefined,
    signal: AbortSignal | undefined;
  const fetcher = vi.fn().mockImplementation((_url, init) => {
    signal = init.signal;
    return new Promise<Response>((done) => {
      resolve = done;
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const lease = r.assistant.voice.acquire("root", {
    kind: "capture",
    requestId: "late",
  });
  const pending = r.assistant.voice.transcribe("root", {
    leaseId: lease.leaseId,
    requestId: "late",
    audio: Buffer.from(wav()).toString("base64"),
  });
  r.assistant.updateSettings({ ...input(r), cloudEnabled: false });
  expect(signal?.aborted).toBe(true);
  expect((await pending).status).toBe("cancelled");
  resolve!(
    new Response(
      JSON.stringify({
        choices: [
          { finish_reason: "stop", message: { content: "待办：不能创建" } },
        ],
      }),
    ),
  );
  await new Promise((done) => setTimeout(done, 10));
  expect(r.assistant.snapshot().todos).toEqual([]);
  expect(r.assistant.snapshot().messages).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("关闭云端中止在途 TTS 下载，保留文字且不播迟到音频", async () => {
  const r = await setup();
  r.assistant.updateSettings(online(r));
  r.assistant.submit("root", { requestId: "text", text: "待办：买牛奶" });
  const message = r.assistant
    .snapshot()
    .messages.find((m) => m.role === "assistant")!;
  const cancelled = vi.fn();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          output: {
            finish_reason: "stop",
            audio: {
              url: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.wav",
            },
          },
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel: cancelled })),
    );
  vi.stubGlobal("fetch", fetcher);
  const lease = r.assistant.voice.acquire("root", {
    kind: "playback",
    requestId: "read",
  });
  const pending = r.assistant.voice.synthesize("root", {
    leaseId: lease.leaseId,
    messageSeq: message.seq,
  });
  const outcome = expect(pending).rejects.toMatchObject({
    code: "voice_cancelled",
  });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  r.assistant.updateSettings({ ...input(r), cloudEnabled: false });
  await outcome;
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(
    r.assistant.snapshot().messages.find((m) => m.seq === message.seq),
  ).toBeDefined();
});
it("配置不接受任意地址或注入，写入失败回滚两类新密钥", async () => {
  const r = await setup();
  for (const patch of [
    { workspaceId: "evil.test/path" },
    { ttsModel: "bad\nmodel" },
    { voiceId: "<script>" },
  ]) {
    const settings = online(r);
    Object.assign(settings.voice.bailian, patch);
    expect(() => r.assistant.updateSettings(settings)).toThrow(
      "voice_settings_invalid",
    );
  }
  expect(() =>
    r.assistant.updateSettings({ ...online(r), speechApiKey: "bad\r\nkey" }),
  ).toThrow("settings_invalid");
  expect(
    readdirSync(dir).filter((name) => name.startsWith("assistant-")),
  ).toEqual([]);
  const transaction = vi
    .spyOn(AssistantStore.prototype, "transaction")
    .mockImplementation(() => {
      throw new Error("fixture disk failure");
    });
  try {
    expect(() =>
      r.assistant.updateSettings({ ...online(r), apiKey: "chat-test-secret" }),
    ).toThrow("fixture disk failure");
    expect(
      readdirSync(dir).filter((name) => name.startsWith("assistant-")),
    ).toEqual([]);
  } finally {
    transaction.mockRestore();
  }
});
