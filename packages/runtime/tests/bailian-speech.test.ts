import { afterEach, expect, it, vi } from "vitest";
import { captureWave, defaultBailianSettings } from "@maneki-pet/core";
import {
  BailianRecognizer,
  BailianSynthesizer,
} from "../src/bailian-speech.js";
const wav = captureWave(
  Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i / 5) * 0.2),
  16000,
);
const config = defaultBailianSettings();
const context = () => ({
  requestId: "test",
  signal: new AbortController().signal,
  deadlineAtMs: Date.now() + 2000,
});
const asrReply = {
  choices: [{ finish_reason: "stop", message: { content: "待办：买牛奶" } }],
};
const audioLink =
  "http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.wav?Expires=123&Signature=private-signature";
const ttsReply = (url = audioLink) => ({
  output: { finish_reason: "stop", audio: { url } },
});
afterEach(() => vi.unstubAllGlobals());
it("ASR 只发送本段 Data URI 和语言，完整结果才接收；无自动重试或原文错误", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(asrReply)));
  vi.stubGlobal("fetch", fetcher);
  const client = new BailianRecognizer(
    { ...config, workspaceId: "workspace-1" },
    "speech-test-key",
    "zh",
  );
  expect(
    await client.transcribe({ bytes: wav, mimeType: "audio/wav" }, context()),
  ).toEqual({ text: "待办：买牛奶" });
  const [url, options] = fetcher.mock.calls[0]!;
  expect(url).toBe(
    "https://workspace-1.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
  expect(options.redirect).toBe("error");
  expect(options.headers.authorization).toBe("Bearer speech-test-key");
  expect(JSON.parse(options.body)).toEqual({
    model: "qwen3-asr-flash",
    stream: false,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: {
              data: `data:audio/wav;base64,${Buffer.from(wav).toString("base64")}`,
            },
          },
        ],
      },
    ],
    asr_options: { enable_itn: false, language: "zh" },
  });
  for (const [response, code] of [
    [
      new Response("private audio and secret", { status: 401 }),
      "speech_auth_failed",
    ],
    [new Response("x".repeat(262145)), "speech_output_limit"],
    [
      new Response(
        JSON.stringify({
          choices: [
            { finish_reason: "length", message: { content: "partial" } },
          ],
        }),
      ),
      "speech_invalid_response",
    ],
    [new Response("<private invalid json>"), "speech_invalid_response"],
  ] as const) {
    fetcher.mockClear().mockResolvedValue(response);
    await expect(
      client.transcribe({ bytes: wav, mimeType: "audio/wav" }, context()),
    ).rejects.toMatchObject({ message: code, code });
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});
it("自动语言不发送固定语种；静音在网络之前拒绝", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(asrReply)));
  vi.stubGlobal("fetch", fetcher);
  const client = new BailianRecognizer(config, "speech-test-key", "auto");
  await client.transcribe({ bytes: wav, mimeType: "audio/wav" }, context());
  expect(JSON.parse(fetcher.mock.calls[0]![1].body).asr_options).toEqual({
    enable_itn: false,
  });
  fetcher.mockClear();
  await expect(
    client.transcribe(
      {
        bytes: captureWave(new Float32Array(16000), 16000),
        mimeType: "audio/wav",
      },
      context(),
    ),
  ).rejects.toMatchObject({ code: "audio_invalid" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("TTS 仅发送本段文字，签名 WAV 强制 HTTPS、下载无 API 密钥且不持久化 URL", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(ttsReply())))
    .mockResolvedValueOnce(new Response(wav));
  vi.stubGlobal("fetch", fetcher);
  const result = await new BailianSynthesizer(
    config,
    "speech-test-key",
  ).synthesize(
    { text: "已经记下。", voiceId: "local-system-voice" },
    context(),
  );
  expect(new Uint8Array(result.bytes)).toEqual(wav);
  expect(result.mimeType).toBe("audio/wav");
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({
    model: "qwen3-tts-flash",
    input: { text: "已经记下。", voice: "Cherry", language_type: "Auto" },
  });
  expect(fetcher.mock.calls[1]![0]).toBe(audioLink.replace("http:", "https:"));
  expect(fetcher.mock.calls[1]![1]).toMatchObject({
    method: "GET",
    redirect: "error",
  });
  expect(fetcher.mock.calls[1]![1].headers).toBeUndefined();
});
it("不跟随音频重定向，拒绝非官方桶/端口/用户信息和超限/假 WAV", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const client = new BailianSynthesizer(config, "speech-test-key");
  for (const url of [
    "http://127.0.0.1/test.wav",
    "https://evil.test/test.wav",
    "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com.evil.test/test.wav",
    "https://user@dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.wav",
    "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com:444/test.wav",
    "file:///test.wav",
  ]) {
    fetcher
      .mockReset()
      .mockResolvedValue(new Response(JSON.stringify(ttsReply(url))));
    await expect(
      client.synthesize({ text: "hello" }, context()),
    ).rejects.toMatchObject({ code: "speech_audio_url_invalid" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
  for (const [response, code] of [
    [new Response("redirect", { status: 302 }), "speech_failed"],
    [new Response("x".repeat(2097153)), "speech_output_limit"],
    [new Response("not-wave"), "speech_audio_invalid"],
  ] as const) {
    fetcher
      .mockReset()
      .mockResolvedValueOnce(new Response(JSON.stringify(ttsReply())))
      .mockResolvedValueOnce(response);
    await expect(
      client.synthesize({ text: "hello" }, context()),
    ).rejects.toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledTimes(2);
  }
});
it("取消/超时覆盖 API 与流式读取，不泄露底层网络异常", async () => {
  const fetcher = vi.fn().mockImplementation(
    (_url, _options) =>
      new Promise((_resolve, reject) => {
        _options.signal.addEventListener(
          "abort",
          () => reject(new Error("private-key-and-url")),
          { once: true },
        );
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const client = new BailianRecognizer(config, "speech-test-key", "zh"),
    controller = new AbortController();
  const pending = client.transcribe(
    { bytes: wav, mimeType: "audio/wav" },
    { ...context(), signal: controller.signal },
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "voice_cancelled" });
  await expect(
    client.transcribe(
      { bytes: wav, mimeType: "audio/wav" },
      { ...context(), deadlineAtMs: Date.now() + 20 },
    ),
  ).rejects.toMatchObject({ code: "speech_timeout" });
  fetcher.mockReset().mockRejectedValue(new Error("private-key-and-url"));
  await expect(
    client.transcribe({ bytes: wav, mimeType: "audio/wav" }, context()),
  ).rejects.toMatchObject({ message: "speech_unavailable" });
  const stopped = vi.fn();
  fetcher.mockResolvedValue(
    new Response(new ReadableStream({ cancel: stopped })),
  );
  await expect(
    client.transcribe(
      { bytes: wav, mimeType: "audio/wav" },
      { ...context(), deadlineAtMs: Date.now() + 20 },
    ),
  ).rejects.toMatchObject({ code: "speech_timeout" });
  expect(stopped).toHaveBeenCalledTimes(1);
});
it("取消覆盖 TTS 音频下载，忽略 fetch 迟到成功结果", async () => {
  const controller = new AbortController();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(ttsReply())))
    .mockImplementationOnce(async () => {
      controller.abort();
      return new Response(wav);
    });
  vi.stubGlobal("fetch", fetcher);
  await expect(
    new BailianSynthesizer(config, "speech-test-key").synthesize(
      { text: "hello" },
      { ...context(), signal: controller.signal },
    ),
  ).rejects.toMatchObject({ code: "voice_cancelled" });
});
