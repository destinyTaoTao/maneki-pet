import { expect, it } from "vitest";
import {
  captureWave,
  pcmWaveInfo,
  validCaptureWave,
  VoiceLease,
} from "../src/speech-provider.js";
it("采集音频规范化、限时、静音筛选与畸形长度拒绝", () => {
  const samples = Float32Array.from(
    { length: 48000 },
    (_, i) => Math.sin((i / 48000) * 440 * Math.PI * 2) * 0.2,
  );
  const wav = captureWave(samples, 48000);
  expect(pcmWaveInfo(wav)).toEqual({
    rate: 16000,
    channels: 1,
    samples: 16000,
    offset: 44,
  });
  expect(validCaptureWave(wav)).toBe(true);
  expect(validCaptureWave(captureWave(new Float32Array(16000), 16000))).toBe(
    false,
  );
  expect(validCaptureWave(captureWave(samples.slice(0, 4800), 48000))).toBe(
    false,
  );
  const bad = wav.slice();
  new DataView(bad.buffer).setUint32(40, 0xffffffff, true);
  expect(pcmWaveInfo(bad)).toBeNull();
  expect(() => captureWave(new Float32Array(16000 * 31), 16000)).toThrow();
});
it("单 owner 到期/确认释放前不抢占，关闭后的租约不可续期，播放不能直接变采集", () => {
  const lease = new VoiceLease(),
    one = {
      client: "one",
      id: "lease1",
      requestId: "request",
      kind: "capture" as const,
      epoch: 0,
      version: 0,
    };
  expect(lease.acquire(one, 100)?.expires).toBe(8100);
  expect(
    lease.acquire({ ...one, client: "two", id: "lease2" }, 200),
  ).toBeNull();
  expect(lease.renew("two", "lease1", "playback", 300)).toBeNull();
  expect(lease.renew("one", "lease1", "playback", 300)?.expires).toBe(8300);
  expect(lease.renew("one", "lease1", "capture", 400)).toBeNull();
  lease.invalidate();
  expect(lease.renew("one", "lease1", "playback", 500)).toBeNull();
  expect(lease.acquire({ ...one, client: "two" }, 600)).toBeNull();
  expect(
    lease.acquire({ ...one, client: "two", id: "lease2" }, 8300)?.client,
  ).toBe("two");
  expect(lease.release("one", "lease2")).toBe(false);
  expect(lease.release("two", "lease2")).toBe(true);
});
