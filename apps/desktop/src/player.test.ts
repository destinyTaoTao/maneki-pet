import { afterEach, expect, it, vi } from "vitest";
import type { PetPack, Playback } from "@maneki-pet/core";
import * as media from "./bounded-fetch.js";
import { PetPlayer } from "./player.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const clip: PetPack["clips"][string] = { sources: [{ renderer: "spritesheet", path: "assets/frame.png", mimeType: "image/png", frameWidth: 1, frameHeight: 1, frameCount: 1, framesPerSecond: 1 }] };
const pack: PetPack = {
  schemaVersion: 1, id: "fixture", name: "测试", version: "1.0.0", permissions: [],
  clips: { idle: clip, working: clip, wave: clip },
  states: { idle: { clips: ["idle"], weights: [1] }, working: { clips: ["working"], weights: [1] } },
  actions: [{ id: "wave", clips: ["wave"], priority: 1, interruptible: true }],
};

function setup() {
  vi.stubGlobal("document", { createElement: () => ({}) });
  // 只观察实际 AnimationChain 输出，媒体解码/设备不进入本测试。
  const render = vi.spyOn(PetPlayer.prototype as unknown as { render(playback: Playback): void }, "render").mockImplementation(() => undefined);
  const player = new PetPlayer({} as HTMLElement, () => undefined);
  return { player, current: () => render.mock.lastCall![0] };
}

it("素材校验完成前到达的共享状态在首次加载后显示", () => {
  const { player, current } = setup();
  player.setState("working");
  player.loadPack(pack, "fixture");
  expect(current()).toMatchObject({ state: "working", clipId: "working" });
});

it("换包重新选择最新状态，不重放已经开始的短动作", () => {
  const { player, current } = setup();
  player.loadPack(pack, "fixture");
  player.setState("working");
  player.playAction("wave");
  expect(current().actionId).toBe("wave");
  player.loadPack(pack, "other");
  expect(current()).toMatchObject({ state: "working", clipId: "working" });
  expect(current().actionId).toBeUndefined();
});

it("缺省状态的包回退 idle 后，完整包仍恢复最近状态且已过期状态不重播", () => {
  const { player, current } = setup();
  player.setState("celebrating");
  player.setState("working");
  player.loadPack({ ...pack, states: { idle: pack.states.idle } }, "minimal");
  expect(current().state).toBe("idle");
  player.loadPack(pack, "fixture");
  expect(current().state).toBe("working");
});

function setupVideo() {
  vi.useFakeTimers();
  const video = {
    onloadedmetadata: null as (() => void) | null,
    src: "", currentSrc: "", readyState: 0, videoWidth: 384, videoHeight: 384,
    canPlayType: () => "probably",
    getAttribute: () => video.src,
    removeAttribute: vi.fn(() => { video.src = ""; }),
    pause: vi.fn(), load: vi.fn(), play: vi.fn(async () => {}),
  };
  vi.stubGlobal("document", { createElement: (tag: string) => tag === "video" ? video : {} });
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.spyOn(media, "readMedia").mockResolvedValue(new ArrayBuffer(8));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const onFallback = vi.fn(), onRestricted = vi.fn(), onRecovered = vi.fn();
  const player = new PetPlayer({ replaceChildren: vi.fn() } as unknown as HTMLElement, onFallback, onRestricted, onRecovered);
  const videoPack: PetPack = {
    ...pack,
    clips: { idle: { sources: [{ renderer: "video-alpha", mimeType: "video/webm", path: "assets/idle.webm" }] } },
    states: { idle: pack.states.idle },
  };
  player.loadPack(videoPack, "fixture");
  return { player, video, onFallback, onRestricted, onRecovered };
}

it.each(["未收到元数据", "播放启动迟到"])("视频启动超时（%s）时释放解码器并回退到安全形象", async (stage) => {
  const { player, video, onFallback, onRestricted, onRecovered } = setupVideo();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(video.src).toBe("blob:fixture");
    let resolvePlay = () => {};
    if (stage === "播放启动迟到") {
      video.play.mockImplementationOnce(() => new Promise<void>((resolve) => { resolvePlay = resolve; }));
      video.currentSrc = video.src;
      video.readyState = 1;
      video.onloadedmetadata?.();
      expect(video.play).toHaveBeenCalledOnce();
    }
    await vi.advanceTimersByTimeAsync(4999);
    expect(onFallback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onRestricted).toHaveBeenCalledOnce();
    expect(onFallback).toHaveBeenCalledOnce();
    expect(video.src).toBe("");
    expect(video.load).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fixture");
    resolvePlay();
    await vi.advanceTimersByTimeAsync(0);
    expect(onRecovered).not.toHaveBeenCalled();
  } finally { player.dispose(); }
});

it("视频及时开始播放后不会被启动计时器中断", async () => {
  const { player, video, onFallback, onRestricted, onRecovered } = setupVideo();
  try {
    await vi.advanceTimersByTimeAsync(0);
    video.currentSrc = video.src;
    video.readyState = 1;
    video.onloadedmetadata?.();
    await vi.advanceTimersByTimeAsync(6000);
    expect(onRecovered).toHaveBeenCalledOnce();
    expect(onFallback).not.toHaveBeenCalled();
    expect(onRestricted).not.toHaveBeenCalled();
    expect(video.src).toBe("blob:fixture");
  } finally { player.dispose(); }
});
