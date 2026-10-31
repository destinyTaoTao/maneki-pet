import { describe, expect, it } from "vitest";

import { AnimationChain, type PetPack } from "../src/index.js";

const pack: PetPack = {
  schemaVersion: 1,
  id: "xiaozhao-default",
  name: "小招",
  version: "1.0.0",
  permissions: [],
  clips: {
    breathe: {
      sources: [
        {
          renderer: "spritesheet",
          path: "assets/breathe.png",
          mimeType: "image/png",
          frameWidth: 128,
          frameHeight: 128,
          frameCount: 2,
          framesPerSecond: 2,
        },
      ],
    },
  },
  states: {
    idle: { clips: ["breathe"], weights: [1] },
  },
  actions: [],
};

describe("AnimationChain", () => {
  it("falls back to idle when the requested state is missing", () => {
    const chain = new AnimationChain(pack, () => 0);

    const playback = chain.setState("working");

    expect(playback.clipId).toBe("breathe");
    expect(playback.state).toBe("idle");
  });

  it("continues with a positive-weight clip when the current clip ends", () => {
    const weightedPack: PetPack = {
      ...pack,
      clips: {
        ...pack.clips,
        wave: { sources: pack.clips.breathe!.sources },
      },
      states: { idle: { clips: ["breathe", "wave"], weights: [0, 1] } },
    };
    const chain = new AnimationChain(weightedPack, () => 0);

    expect(chain.current.clipId).toBe("wave");
    expect(chain.complete(chain.current.id).clipId).toBe("wave");
  });

  it("plays action clips in order and returns to the latest state", () => {
    const actionPack: PetPack = {
      ...pack,
      clips: {
        ...pack.clips,
        wave: { sources: pack.clips.breathe!.sources },
      },
      states: {
        idle: pack.states.idle,
        working: { clips: ["wave"], weights: [1] },
      },
      actions: [
        { id: "wave", clips: ["wave", "breathe"], priority: 1, interruptible: true },
      ],
    };
    const chain = new AnimationChain(actionPack, () => 0);
    chain.setState("working");

    expect(chain.play("wave")?.clipId).toBe("wave");
    expect(chain.complete(chain.current.id).clipId).toBe("breathe");
    const fallback = chain.complete(chain.current.id);
    expect(fallback.clipId).toBe("wave");
    expect(fallback.state).toBe("working");
    expect(fallback.actionId).toBeUndefined();
  });

  it("ignores an ended event from an interrupted playback", () => {
    const chain = new AnimationChain(
      {
        ...pack,
        actions: [
          { id: "wave", clips: ["breathe"], priority: 1, interruptible: true },
        ],
      },
      () => 0,
    );
    const interruptedId = chain.play("wave")!.id;
    const replacement = chain.setState("idle");

    const result = chain.complete(interruptedId);

    expect(result.id).toBe(replacement.id);
    expect(result.clipId).toBe(replacement.clipId);
  });

  it("rejects a lower-priority action and accepts a higher-priority one", () => {
    const chain = new AnimationChain(
      {
        ...pack,
        actions: [
          { id: "low", clips: ["breathe"], priority: 1, interruptible: true },
          { id: "wave", clips: ["breathe"], priority: 2, interruptible: true },
          { id: "celebrate", clips: ["breathe"], priority: 3, interruptible: true },
        ],
      },
      () => 0,
    );
    chain.play("wave");

    expect(chain.play("low")).toBeUndefined();
    expect(chain.current.actionId).toBe("wave");
    expect(chain.play("celebrate")?.actionId).toBe("celebrate");
  });

  it("lets only a PetState change preempt a non-interruptible action", () => {
    const chain = new AnimationChain(
      {
        ...pack,
        actions: [
          { id: "sleep", clips: ["breathe"], priority: 1, interruptible: false },
          { id: "celebrate", clips: ["breathe"], priority: 9, interruptible: true },
        ],
      },
      () => 0,
    );
    chain.play("sleep");

    expect(chain.play("celebrate")).toBeUndefined();
    expect(chain.setState("working").actionId).toBeUndefined();
    expect(chain.play("celebrate")?.actionId).toBe("celebrate");
  });

  it("handles large finite weights without overflowing", () => {
    const weightedPack: PetPack = {
      ...pack,
      clips: {
        ...pack.clips,
        wave: { sources: pack.clips.breathe!.sources },
      },
      states: {
        idle: {
          clips: ["breathe", "wave"],
          weights: [Number.MAX_VALUE, Number.MAX_VALUE],
        },
      },
    };
    const randomValues = [0, 0.999999];
    let index = 0;
    const chain = new AnimationChain(weightedPack, () => randomValues[index++] ?? 0);

    expect(chain.current.clipId).toBe("breathe");
    expect(chain.complete(chain.current.id).clipId).toBe("wave");
  });
});
