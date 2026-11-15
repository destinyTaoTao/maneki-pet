import { afterEach, expect, it, vi } from "vitest";
import type { PetPack, Playback } from "@maneki-pet/core";
import { PetPlayer } from "./player.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
