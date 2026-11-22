import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { captureWave } from "../packages/core/dist/index.js";
import { defaultAssistantSettings } from "../packages/runtime/dist/assistant-settings.js";
import { startRuntime } from "../packages/runtime/dist/runtime.js";
import { exerciseHost, repo, withFixture, writeProfile } from "./fixtures/dsh-acceptance.mjs";
import { waitFor } from "./fixtures/dsh-tool-probe.mjs";

assert.equal(process.platform, "win32", "合成测试短句需要 Windows System.Speech");
const modelDirectory = process.env.MANEKI_SENSEVOICE_TEST_ASSETS;
assert.ok(modelDirectory && isAbsolute(modelDirectory), "设置 MANEKI_SENSEVOICE_TEST_ASSETS 为离线模型目录");

async function verifyAssets(dshCli) {
  const manifest = JSON.parse(readFileSync(join(dirname(dshCli), "../node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/runtime/assets.json"), "utf8"));
  for (const [name, asset] of [["model.int8.onnx", manifest.models.int8], ["tokens.txt", manifest.tokens], ["silero_vad.onnx", manifest.vad]]) {
    assert.equal(asset.name, name);
    const path = join(modelDirectory, name);
    assert.equal(statSync(path).size, asset.bytes);
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    assert.equal(hash.digest("hex"), asset.sha256);
  }
}

async function synthesize(env, signal) {
  const code = `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Speech
    $synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
    $buffer = [IO.MemoryStream]::new()
    try {
      $voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
      if (!$voice) { throw 'A zh-CN System.Speech voice is required' }
      $synth.SelectVoice($voice.VoiceInfo.Name)
      $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000, 'Sixteen', 'Mono')
      $synth.SetOutputToAudioStream($buffer, $format)
      $synth.Speak('查看进度')
      $synth.SetOutputToNull()
      [Console]::Write([Convert]::ToBase64String($buffer.ToArray()))
    } finally { $synth.Dispose(); $buffer.Dispose() }
  `;
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code],
    { env, signal, timeout: 10000, maxBuffer: 500000, windowsHide: true });
  const pcm = Buffer.from(stdout.trim(), "base64");
  assert.ok(pcm.length > 0 && pcm.length % 2 === 0 && pcm.length <= 320000, "无效的合成 PCM");
  const samples = Float32Array.from({ length: pcm.length / 2 }, (_, index) => {
    const sample = pcm.readInt16LE(index * 2);
    return sample / (sample < 0 ? 32768 : 32767);
  });
  return Buffer.from(captureWave(samples, 16000)).toString("base64");
}

const result = await withFixture("speech", async ({ lab, env, cwd, configDir, dshCli, version, signal }) => {
  await verifyAssets(dshCli);
  const audio = await synthesize(env, signal);
  const runtime = await startRuntime({ configDir });
  const base = `http://127.0.0.1:${runtime.port}`;
  const call = async (path, token, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(base + "/v1" + path, { method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    return { status: response.status, body: await response.json() };
  };
  const pair = async (name, scopes) => {
    const response = await call("/pair", runtime.rootToken, { name, scopes });
    assert.equal(response.status, 200);
    return response.body;
  };
  try {
    const assistant = await pair("speech-test-view", "assistant,settings");
    const observer = await pair("speech-test-observer", "express");
    const host = await pair("speech-test-host", "speech_host");
    env.MANEKI_VOICE_TEST_URL = base;
    env.MANEKI_VOICE_TEST_TOKEN = host.token;
    env.MANEKI_VOICE_TEST_CLIENT = host.clientId;
    writeProfile(env.DSH_HOME, [
      { id: "subprocess-local", name: "@deepseek-ai/dsh-subprocess-local" },
      { id: "experimental-speech-to-text", name: "@deepseek-ai/dsh-experimental-speech-to-text", config: { defaultProvider: "sensevoice", language: "zh" } },
      { id: "experimental-speech-to-text-sensevoice", name: "@deepseek-ai/dsh-experimental-speech-to-text-sensevoice",
        config: { providerId: "sensevoice", dataRoot: lab, modelDirectory, vadModelPath: join(modelDirectory, "silero_vad.onnx") } },
      { id: "speech-probe", name: join(repo, "scripts/fixtures/dsh-speech-probe.mjs") },
    ]);

    const useAssistant = (path, body, method) => call("/assistant" + path, assistant.token, body, method);
    const waitingAt = Date.now();
    const report = (reportSequence, bPhase) => call("/observations/sessions", observer.token, {
      sourceId: "00000000-0000-4000-8000-000000000066", profileId: "speech-fixture", reportSequence, connected: true, truncated: false,
      sessions: [
        { sessionId: "speech-A", projectName: "project-A", phase: "waiting_input", sequence: 1, observedAt: waitingAt },
        { sessionId: "speech-B", projectName: "project-B", phase: bPhase, sequence: reportSequence, observedAt: Date.now() },
      ],
    });
    let recognition;
    const run = async () => {
      await waitFor(async () => {
        const { body } = await useAssistant("/voice/hosts");
        return body.hosts?.some((item) => item.clientId === host.clientId && item.ready);
      }, "真实 dsh SenseVoice 未就绪", signal, 12000);
      const { schemaVersion: _, ...settings } = defaultAssistantSettings();
      settings.voice.microphoneEnabled = true;
      Object.assign(settings.voice.asr, { enabled: true, provider: "dsh", language: "zh", hostClientId: host.clientId, hostSourceId: "acceptance-sensevoice" });
      assert.equal((await useAssistant("/settings", settings, "PUT")).status, 200);
      assert.equal((await report(1, "working")).status, 202);
      const requestId = "speech-progress";
      const lease = await useAssistant("/voice/acquire", { requestId, kind: "capture" });
      assert.equal(lease.status, 200);
      const { leaseId } = lease.body;
      try {
        assert.equal((await report(2, "completed")).status, 202);
        const started = performance.now();
        const transcribed = await useAssistant("/voice/transcribe", { requestId, leaseId, audio });
        assert.equal(transcribed.status, 200, JSON.stringify(transcribed.body));
        assert.match(transcribed.body.transcript, /查看[进進]度/);
        recognition = { transcript: transcribed.body.transcript, transcribeMs: Math.round(performance.now() - started) };
        const submit = () => useAssistant("/voice/submit", { requestId, leaseId });
        assert.equal((await submit()).body.status, "submitted");
        assert.equal((await submit()).body.status, "submitted");
        const answer = await waitFor(async () => {
          const { body } = await useAssistant(`/chat/${requestId}`);
          return body.status === "completed" && body.message.text;
        }, "未完成确定性语音问答", signal);
        assert.match(answer, /speech-A：等待你回应/);
        assert.match(answer, /speech-B：已完成/);
        const snapshot = await useAssistant("/snapshot");
        assert.equal(snapshot.body.messages.filter((item) => item.role === "user").length, 1);
      } finally {
        await useAssistant("/voice/release", { leaseId });
      }
      const revoked = await call(`/clients/${host.clientId}/revoke`, runtime.rootToken, {});
      assert.equal(revoked.status, 200);
    };
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(40000)]);
    const provider = await exerciseHost(cwd, env, [], run, deadline);
    assert.equal(provider.provider, "sensevoice");
    assert.equal((await useAssistant("/voice/acquire", { requestId: "after-revoke", kind: "capture" })).body.error, "asr_host_unavailable");
    assert.equal((await useAssistant("/chat", { requestId: "text-progress", text: "查看进度" })).status, 202);
    const textAnswer = await waitFor(async () => {
      const { body } = await useAssistant("/chat/text-progress");
      return body.status === "completed" && body.message.text;
    }, "语音授权撤销后文字查询未完成", signal);
    assert.match(textAnswer, /speech-A：等待你回应/);
    return { dsh: version, node: process.version, ...provider, ...recognition, audio: "synthetic", observation: "fixture", hostRevoked: true, textFallback: true };
  } finally {
    await runtime.stop();
  }
});
console.log(JSON.stringify(result, null, 2));
