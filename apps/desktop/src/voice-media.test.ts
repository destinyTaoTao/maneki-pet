import { afterEach, expect, it, vi } from "vitest";
import { pcmWaveInfo, validCaptureWave } from "@maneki-pet/core";
import { BrowserVoiceCapture, BrowserVoicePlayer } from "./voice-media.js";
afterEach(() => vi.unstubAllGlobals());
it("权限返回前取消，迟到的真实设备句柄立即停止且不创建音频上下文", async () => {
  let permit: (stream: MediaStream) => void = () => undefined;
  const stop = vi.fn(),
    Context = vi.fn();
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: () =>
        new Promise<MediaStream>((resolve) => {
          permit = resolve;
        }),
    },
  });
  vi.stubGlobal("AudioContext", Context);
  const capture = new BrowserVoiceCapture(),
    pending = capture.start();
  await capture.cancel();
  permit({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  await expect(pending).rejects.toThrow("voice_cancelled");
  expect(stop).toHaveBeenCalledOnce();
  expect(Context).not.toHaveBeenCalled();
});
it("采集音频只在内存中规范化，结束前先停设备并关闭上下文", async () => {
  const stop = vi.fn(),
    close = vi.fn().mockResolvedValue(undefined),
    module = vi.fn().mockResolvedValue(undefined),
    disconnect = vi.fn();
  let node: {
    port: {
      onmessage: ((event: { data: unknown }) => void) | null;
      postMessage: (value: string) => void;
    };
  };
  class Context {
    sampleRate = 48000;
    audioWorklet = { addModule: module };
    destination = {};
    createMediaStreamSource() {
      return { connect: vi.fn(), disconnect };
    }
    createGain() {
      return { gain: { value: 1 }, connect: vi.fn() };
    }
    resume = vi.fn().mockResolvedValue(undefined);
    close = close;
  }
  class Worklet {
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (_value: string) => {
        this.port.onmessage?.({ data: { flushed: true } });
      },
    };
    constructor() {
      node = this;
    }
    connect = vi.fn();
    disconnect = disconnect;
  }
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }),
    },
  });
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Worklet);
  const capture = new BrowserVoiceCapture();
  await capture.start();
  node!.port.onmessage?.({
    data: Float32Array.from(
      { length: 48000 },
      (_, i) => Math.sin((i / 48000) * 440 * Math.PI * 2) * 0.2,
    ),
  });
  const wave = await capture.finish();
  expect(pcmWaveInfo(wave)?.samples).toBe(16000);
  expect(validCaptureWave(wave)).toBe(true);
  expect(stop).toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
  expect(disconnect).toHaveBeenCalled();
  expect(module.mock.calls[0]![0]).toContain("capture-worklet.js?no-inline");
});
it("播放被拒绝或被打断都释放音频 URL，输出不会流回采集入口", async () => {
  const revoke = vi.fn(),
    pause = vi.fn();
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:test",
    revokeObjectURL: revoke,
  });
  class AudioFake {
    onended: (() => void) | undefined;
    onerror: (() => void) | undefined;
    pause = pause;
    removeAttribute = vi.fn();
    load = vi.fn();
    play() {
      return Promise.reject(new Error("denied"));
    }
  }
  vi.stubGlobal("Audio", AudioFake);
  const player = new BrowserVoicePlayer();
  await expect(player.play(new Uint8Array([1, 2]))).rejects.toThrow(
    "speech_playback_blocked",
  );
  expect(revoke).toHaveBeenCalledWith("blob:test");
  expect(pause).toHaveBeenCalled();
});
