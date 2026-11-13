import { expect, it } from "vitest";
import { SpeechHostBroker } from "../src/speech-host.js";
const secret = "a".repeat(43);

it("只向授权的指定实例领取一次音频，并接受该实例的结果", async () => {
  const broker = new SpeechHostBroker(() => true);
  broker.register("client-a", { protocolVersion: 1, sourceSecret: secret, sourceId: "source-a", providerId: "sensevoice-local", locality: "local", languages: ["zh"], ready: true });
  broker.register("client-b", { protocolVersion: 1, sourceSecret: secret, sourceId: "source-b", providerId: "other", locality: "local", languages: ["zh"], ready: true });
  const pending = broker.transcribe("client-a", "source-a", new Uint8Array([1, 2]), "zh", AbortSignal.timeout(3000));
  expect(broker.claim("client-b", "source-b", secret)).toBeNull();
  expect(broker.claim("client-a", "source-a", "b".repeat(43))).toBeNull();
  const job = broker.claim("client-a", "source-a", secret)!;
  expect(job.audio).toBe("AQI=");
  expect(broker.claim("client-a", "source-a", secret)).toBeNull();
  expect(broker.complete("client-b", "source-b", secret, job.jobId, "错误")).toBe(false);
  expect(broker.complete("client-a", "source-a", secret, job.jobId, "查看进度")).toBe(true);
  await expect(pending).resolves.toEqual({ text: "查看进度" });
});

it("取消、来源失联或授权撤销后不能交付迟到结果", async () => {
  let active = true, now = 0;
  const broker = new SpeechHostBroker(() => active, () => now);
  broker.register("client", { protocolVersion: 1, sourceSecret: secret, sourceId: "source", providerId: "sense", locality: "local", languages: ["zh"], ready: true });
  const cancel = new AbortController();
  const first = broker.transcribe("client", "source", new Uint8Array([1]), "zh", cancel.signal);
  const job = broker.claim("client", "source", secret)!;
  cancel.abort();
  await expect(first).rejects.toMatchObject({ code: "voice_cancelled" });
  expect(broker.complete("client", "source", secret, job.jobId, "迟到")).toBe(false);
  now = 16000;
  expect(broker.list()).toEqual([]);
  await expect(broker.transcribe("client", "source", new Uint8Array([1]), "zh", AbortSignal.timeout(100))).rejects.toMatchObject({ code: "asr_host_unavailable" });
  now = 17000;
  broker.register("client", { protocolVersion: 1, sourceSecret: secret, sourceId: "source", providerId: "sense", locality: "local", languages: ["zh"], ready: true });
  active = false;
  expect(broker.list()).toEqual([]);
});

it("取消后跨 Runtime 重启保留隔离，只有原工作者确认停止才放行", async () => {
  let saved = "";
  const persistence = { get: () => saved, set: (value: string) => { saved = value; } };
  const broker = new SpeechHostBroker(() => true, Date.now, persistence);
  broker.register("client", { protocolVersion: 1, sourceSecret: secret, sourceId: "source", providerId: "sense", locality: "local", languages: ["zh"], ready: true });
  const controller = new AbortController();
  const pending = broker.transcribe("client", "source", new Uint8Array([1]), "zh", controller.signal);
  const job = broker.claim("client", "source", secret)!;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "voice_cancelled" });
  const restarted = new SpeechHostBroker(() => true, Date.now, persistence);
  expect(restarted.busy()).toBe(true);
  expect(restarted.acknowledge("client", "source", "b".repeat(43), job.jobId)).toBe(false);
  expect(restarted.busy()).toBe(true);
  expect(restarted.acknowledge("client", "source", secret, job.jobId)).toBe(true);
  expect(restarted.busy()).toBe(false);
});


it("恢复需要全部宿主心跳失效且当前任务已取消", async () => {
  let now = 0, saved = "";
  const persistence = { get: () => saved, set: (value: string) => { saved = value; } };
  const broker = new SpeechHostBroker(() => true, () => now, persistence);
  broker.register("client", { protocolVersion: 1, sourceSecret: secret, sourceId: "source", providerId: "sense", locality: "local", languages: ["zh"], ready: true });
  const controller = new AbortController();
  const pending = broker.transcribe("client", "source", new Uint8Array([1]), "zh", controller.signal);
  broker.claim("client", "source", secret);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "voice_cancelled" });
  broker.register("client", { protocolVersion: 1, sourceSecret: secret, sourceId: "source", providerId: "sense", locality: "local", languages: ["zh"], ready: false });
  expect(broker.recover()).toBe(false);
  now = 16000;
  expect(broker.recover()).toBe(true);
  expect(broker.busy()).toBe(false);
});
