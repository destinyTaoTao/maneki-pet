import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { captureWave, type SpeechRecognizer } from "@maneki-pet/core";
import { startRuntime, type StartedRuntime } from "../src/runtime.js";
const runtimes: StartedRuntime[] = [],
  dirs: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const audio = (frequency = 440, seconds = 1) =>
  Buffer.from(
    captureWave(
      Float32Array.from(
        { length: 16000 * seconds },
        (_, i) => Math.sin((i / 16000) * frequency * Math.PI * 2) * 0.15,
      ),
      16000,
    ),
  ).toString("base64");
async function setup(
  transcribe = vi
    .fn<SpeechRecognizer["transcribe"]>()
    .mockResolvedValue({ text: "待办：买牛奶" }),
) {
  const dir = mkdtempSync(join(tmpdir(), "maneki-voice-"));
  dirs.push(dir);
  const synthesize = vi.fn().mockResolvedValue({
    bytes: Buffer.from(audio(), "base64"),
    mimeType: "audio/wav",
  });
  const runtime = await startRuntime({
    configDir: dir,
    speech: {
      recognizer: () => ({
        info: { id: "fixture", apiVersion: 1, locality: "local" },
        transcribe,
      }),
      synthesizer: {
        info: { id: "fixture", apiVersion: 1, locality: "local" },
        synthesize,
      },
    },
  });
  runtimes.push(runtime);
  const base = `http://127.0.0.1:${runtime.port}/v1`;
  const call = async (
    path: string,
    body?: unknown,
    token = runtime.rootToken,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const first = (
    await call("/pair", { name: "voice", scopes: "assistant,settings" })
  ).body.token as string;
  const other = (
    await call("/pair", { name: "other", scopes: "assistant,settings" })
  ).body.token as string;
  const settings = () => call("/assistant/settings", undefined, first);
  const enable = async () => {
    const {
      schemaVersion: _,
      chat: { apiKeyConfigured: __, ...chat },
      ...rest
    } = (await settings()).body;
    return call(
      "/assistant/settings",
      {
        ...rest,
        chat,
        voice: {
          microphoneEnabled: true,
          asr: { enabled: true, language: "zh" },
          tts: { enabled: true, voiceId: "" },
        },
      },
      first,
      "PUT",
    );
  };
  return {
    dir,
    runtime,
    call,
    first,
    other,
    settings,
    enable,
    transcribe,
    synthesize,
  };
}
it("默认不开麦，旧设置保存保留语音偏好，观察端无语音权限且租约不能借用", async () => {
  const { call, first, other, enable, settings, transcribe } = await setup();
  expect(
    (
      await call(
        "/assistant/voice/acquire",
        { requestId: "r", kind: "capture" },
        first,
      )
    ).status,
  ).toBe(403);
  expect(transcribe).not.toHaveBeenCalled();
  const observer = (
    await call("/pair", { name: "observer", scopes: "express" })
  ).body.token;
  expect(
    (await call("/assistant/voice/status", undefined, observer)).status,
  ).toBe(403);
  expect((await enable()).status).toBe(200);
  const {
    schemaVersion: _,
    voice: __,
    chat: { apiKeyConfigured: ___, ...chat },
    ...oldInput
  } = (await settings()).body;
  expect(
    (await call("/assistant/settings", { ...oldInput, chat }, first, "PUT"))
      .body.voice.microphoneEnabled,
  ).toBe(true);
  const lease = (
    await call(
      "/assistant/voice/acquire",
      { requestId: "r", kind: "capture" },
      first,
    )
  ).body;
  expect(
    (
      await call(
        "/assistant/voice/acquire",
        { requestId: "other", kind: "capture" },
        other,
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await call(
        "/assistant/voice/transcribe",
        { leaseId: lease.leaseId, requestId: "r", audio: audio() },
        other,
      )
    ).status,
  ).toBe(409);
  expect(
    (await call("/assistant/voice/release", { leaseId: lease.leaseId }, other))
      .body.released,
  ).toBe(false);
  expect(
    (await call("/assistant/voice/release", { leaseId: lease.leaseId }, first))
      .body.released,
  ).toBe(true);
});
it("转写成功只提交一次，重复音频返回原请求，完成后复用同一租约播报，音频不落盘", async () => {
  const { call, first, enable, transcribe, synthesize, dir } = await setup();
  await enable();
  const lease = (
    await call(
      "/assistant/voice/acquire",
      { requestId: "spoken", kind: "capture" },
      first,
    )
  ).body;
  const body = {
    leaseId: lease.leaseId,
    requestId: "spoken",
    audio: audio(440, 5),
  };
  expect(
    (await call("/assistant/voice/transcribe", body, first)).body,
  ).toMatchObject({ status: "recognized", transcript: "待办：买牛奶" });
  expect(
    (await call("/assistant/voice/transcribe", body, first)).body.status,
  ).toBe("recognized");
  expect(
    (await call("/assistant/snapshot", undefined, first)).body.todos,
  ).toEqual([]);
  const commit = { leaseId: lease.leaseId, requestId: "spoken" };
  expect(
    (await call("/assistant/voice/submit", commit, first)).body.status,
  ).toBe("submitted");
  expect(
    (await call("/assistant/voice/submit", commit, first)).body.status,
  ).toBe("submitted");
  expect(transcribe).toHaveBeenCalledOnce();
  expect(
    (
      await call(
        "/assistant/voice/transcribe",
        { ...body, audio: audio(330) },
        first,
      )
    ).status,
  ).toBe(409);
  const snapshot = (await call("/assistant/snapshot", undefined, first)).body;
  expect(snapshot.todos).toHaveLength(1);
  expect(
    (
      await call(
        "/assistant/voice/renew",
        { leaseId: lease.leaseId, kind: "playback" },
        first,
      )
    ).status,
  ).toBe(200);
  const message = snapshot.messages.at(-1);
  expect(
    (
      await call(
        "/assistant/voice/synthesize",
        { leaseId: lease.leaseId, messageSeq: message.seq },
        first,
      )
    ).status,
  ).toBe(200);
  expect(synthesize).toHaveBeenCalledOnce();
  expect(
    (
      await call(
        "/assistant/voice/synthesize",
        { leaseId: lease.leaseId, messageSeq: 1, text: "任意文本" },
        first,
      )
    ).status,
  ).toBe(400);
  expect(
    readdirSync(dir).filter((name) => /wav|pcm|audio/i.test(name)),
  ).toEqual([]);
});
it("取消与清空隔离忽略 abort 的迟到转写，重复请求不能复活待办或历史", async () => {
  let finish: (value: { text: string }) => void = () => undefined;
  const transcribe = vi.fn<SpeechRecognizer["transcribe"]>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { call, first, other, enable } = await setup(transcribe);
  await enable();
  const lease = (
    await call(
      "/assistant/voice/acquire",
      { requestId: "late", kind: "capture" },
      first,
    )
  ).body;
  const body = { leaseId: lease.leaseId, requestId: "late", audio: audio() },
    pending = call("/assistant/voice/transcribe", body, first);
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
  expect(
    (await call("/assistant/voice/transcribe", body, first)).body.status,
  ).toBe("pending");
  const preview = (
    await call("/assistant/clear-preview", { scope: "history" }, first)
  ).body;
  await call(
    "/assistant/clear",
    { confirmationId: preview.confirmationId },
    first,
  );
  expect(transcribe.mock.calls[0]![1].signal.aborted).toBe(true);
  expect(
    (
      await call(
        "/assistant/voice/acquire",
        { requestId: "new", kind: "capture" },
        other,
      )
    ).status,
  ).toBe(409);
  finish({ text: "待办：不得恢复" });
  expect((await pending).body.status).toBe("cleared");
  expect(
    (await call("/assistant/voice/transcribe", body, first)).body.status,
  ).toBe("cleared");
  const snapshot = (await call("/assistant/snapshot", undefined, first)).body;
  expect(snapshot.messages).toEqual([]);
  expect(snapshot.todos).toEqual([]);
});
it("静音不调用 ASR，关闭麦克风会中止在途处理且保持文字入口", async () => {
  let finish: (value: { text: string }) => void = () => undefined;
  const transcribe = vi.fn<SpeechRecognizer["transcribe"]>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { call, first, enable, settings } = await setup(transcribe);
  await enable();
  const lease = (
    await call(
      "/assistant/voice/acquire",
      { requestId: "late", kind: "capture" },
      first,
    )
  ).body;
  const silent = Buffer.from(
    captureWave(new Float32Array(16000), 16000),
  ).toString("base64");
  expect(
    (
      await call(
        "/assistant/voice/transcribe",
        { leaseId: lease.leaseId, requestId: "late", audio: silent },
        first,
      )
    ).status,
  ).toBe(422);
  expect(transcribe).not.toHaveBeenCalled();
  const pending = call(
    "/assistant/voice/transcribe",
    { leaseId: lease.leaseId, requestId: "late", audio: audio() },
    first,
  );
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
  const {
    schemaVersion: _,
    chat: { apiKeyConfigured: __, ...chat },
    ...input
  } = (await settings()).body;
  input.voice.microphoneEnabled = false;
  await call("/assistant/settings", { ...input, chat }, first, "PUT");
  finish({ text: "待办：取消" });
  expect((await pending).body.status).toBe("cancelled");
  expect(
    (
      await call(
        "/assistant/chat",
        { requestId: "text", text: "待办：文字仍可用" },
        first,
      )
    ).status,
  ).toBe(202);
  expect(
    (await call("/assistant/snapshot", undefined, first)).body.todos,
  ).toHaveLength(1);
});
it("识别完成但 Shell 已取消或失联时没有自动变更，不能替换候选文本或借用提交", async () => {
  const { call, first, other, enable } = await setup();
  await enable();
  const lease = (
    await call(
      "/assistant/voice/acquire",
      { requestId: "uncommitted", kind: "capture" },
      first,
    )
  ).body;
  expect(
    (
      await call(
        "/assistant/voice/transcribe",
        { leaseId: lease.leaseId, requestId: "uncommitted", audio: audio() },
        first,
      )
    ).body.status,
  ).toBe("recognized");
  expect(
    (await call("/assistant/snapshot", undefined, first)).body.messages,
  ).toEqual([]);
  expect(
    (
      await call(
        "/assistant/voice/submit",
        { leaseId: lease.leaseId, requestId: "uncommitted", text: "替换" },
        first,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await call(
        "/assistant/voice/submit",
        { leaseId: lease.leaseId, requestId: "uncommitted" },
        other,
      )
    ).status,
  ).toBe(404);
  await call("/assistant/voice/release", { leaseId: lease.leaseId }, first);
  expect(
    (
      await call(
        "/assistant/voice/submit",
        { leaseId: lease.leaseId, requestId: "uncommitted" },
        first,
      )
    ).body.status,
  ).toBe("cancelled");
  expect(
    (await call("/assistant/snapshot", undefined, first)).body.todos,
  ).toEqual([]);
});
it("语音输出关闭立即中止合成回执，迟到音频不回传而文字仍保留", async () => {
  const { call, first, enable, synthesize, settings } = await setup();
  await enable();
  let finish: (audio: { bytes: Buffer; mimeType: string }) => void = () =>
    undefined;
  synthesize.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await call("/assistant/chat", { requestId: "text", text: "你好" }, first);
  const snapshot = (await call("/assistant/snapshot", undefined, first)).body;
  const lease = (
    await call(
      "/assistant/voice/acquire",
      { requestId: "read", kind: "playback" },
      first,
    )
  ).body;
  const pending = call(
    "/assistant/voice/synthesize",
    { leaseId: lease.leaseId, messageSeq: snapshot.messages.at(-1).seq },
    first,
  );
  await vi.waitFor(() => expect(synthesize).toHaveBeenCalledOnce());
  const {
    schemaVersion: _,
    chat: { apiKeyConfigured: __, ...chat },
    ...input
  } = (await settings()).body;
  input.voice.tts.enabled = false;
  await call("/assistant/settings", { ...input, chat }, first, "PUT");
  const result = await pending;
  expect(result.status).toBe(499);
  expect(result.body).not.toHaveProperty("audio");
  finish({ bytes: Buffer.from(audio(), "base64"), mimeType: "audio/wav" });
  expect(
    (await call("/assistant/snapshot", undefined, first)).body.messages.length,
  ).toBeGreaterThan(0);
});
it("Provider 永不响应也不能阻塞取消回执和 Runtime 退出；清理未确认前不再采集", async () => {
  const transcribe = vi.fn<SpeechRecognizer["transcribe"]>(
    () => new Promise(() => undefined),
  );
  const { call, first, enable, runtime } = await setup(transcribe);
  await enable();
  const lease = (
    await call(
      "/assistant/voice/acquire",
      { requestId: "hung", kind: "capture" },
      first,
    )
  ).body;
  const pending = call(
    "/assistant/voice/transcribe",
    { leaseId: lease.leaseId, requestId: "hung", audio: audio() },
    first,
  );
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
  await call("/assistant/voice/cancel", { leaseId: lease.leaseId }, first);
  expect((await pending).body.status).toBe("cancelled");
  expect(
    (
      await call(
        "/assistant/voice/acquire",
        { requestId: "another", kind: "capture" },
        first,
      )
    ).status,
  ).toBe(409);
  await Promise.race([
    runtime.stop(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("stop blocked")), 2000),
    ),
  ]);
});
