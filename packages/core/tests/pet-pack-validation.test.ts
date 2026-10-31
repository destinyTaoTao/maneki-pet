import { describe, expect, it } from "vitest";

import {
  validatePetPack,
  type AssetManifest,
  type PetPack,
} from "../src/index.js";

const validPack: PetPack = {
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

const validManifest: AssetManifest = {
  schemaVersion: 1,
  algorithm: "sha256",
  files: [
    {
      path: "assets/breathe.png",
      sha256: "a".repeat(64),
      bytes: 128,
    },
  ],
};

describe("validatePetPack", () => {
  it("enforces the v1 JSON Schemas", () => {
    const valid = validatePetPack(validPack, validManifest);
    expect(valid.success).toBe(true);
    if (valid.success) {
      expect(valid.value.pack).toEqual(validPack);
      expect(valid.value.manifest).toEqual(validManifest);
    }

    const invalidPacks: unknown[] = [
      { ...validPack, schemaVersion: 2 },
      { ...validPack, permissions: ["network"] },
      { ...validPack, unexpected: true },
    ];
    for (const candidate of invalidPacks) {
      expect(validatePetPack(candidate, validManifest).success).toBe(false);
    }
  });

  it("rejects missing clip references and invalid weight chains", () => {
    const invalidPacks: unknown[] = [
      { ...validPack, states: { idle: { clips: ["missing"], weights: [1] } } },
      { ...validPack, states: { idle: { clips: ["breathe"], weights: [0] } } },
      { ...validPack, states: { idle: { clips: ["breathe"], weights: [1, 0] } } },
      {
        ...validPack,
        actions: [
          { id: "wave", clips: ["missing"], priority: 1, interruptible: true },
        ],
      },
    ];

    for (const candidate of invalidPacks) {
      expect(validatePetPack(candidate, validManifest).success).toBe(false);
    }
  });

  it("rejects unsafe asset paths", () => {
    const source = validPack.clips.breathe!.sources[0]!;
    const entry = validManifest.files[0]!;
    const unsafePaths = [
      "../escape.png",
      "/absolute.png",
      "C:/escape.png",
      "assets\\escape.png",
      "assets//breathe.png",
      "assets/./breathe.png",
      "https://example.com/breathe.png",
      "pet-pack.json",
      "assets.manifest.json",
    ];

    for (const path of unsafePaths) {
      const pack = {
        ...validPack,
        clips: { breathe: { sources: [{ ...source, path }] } },
      };
      const manifest = { ...validManifest, files: [{ ...entry, path }] };
      expect(validatePetPack(pack, manifest).success).toBe(false);
    }
  });

  it("requires exact, unique asset manifest coverage", () => {
    const entry = validManifest.files[0]!;
    const invalidManifests: unknown[] = [
      { ...validManifest, files: [] },
      { ...validManifest, files: [entry, entry] },
      {
        ...validManifest,
        files: [entry, { ...entry, path: "assets/unreferenced.png" }],
      },
      {
        ...validManifest,
        files: [{ ...entry, path: "assets/mismatch.png" }],
      },
    ];

    for (const manifest of invalidManifests) {
      expect(validatePetPack(validPack, manifest).success).toBe(false);
    }
  });

  it("enforces the aggregate asset size limit", () => {
    const source = validPack.clips.breathe!.sources[0]!;
    const entry = validManifest.files[0]!;
    const sources = Array.from({ length: 5 }, (_, index) => ({
      ...source,
      path: `assets/${index}.png`,
    }));
    const files = sources.map((item) => ({
      ...entry,
      path: item.path,
      bytes: 64 * 1024 * 1024,
    }));
    const pack = { ...validPack, clips: { breathe: { sources } } };

    expect(validatePetPack(pack, { ...validManifest, files }).success).toBe(false);
  });

  it("rejects duplicate action IDs", () => {
    const action = { id: "wave", clips: ["breathe"], priority: 1, interruptible: true };

    expect(validatePetPack({ ...validPack, actions: [action, action] }, validManifest).success).toBe(
      false,
    );
  });

  it("rejects duplicate clip references in state and action chains", () => {
    const duplicateState = {
      ...validPack,
      states: { idle: { clips: ["breathe", "breathe"], weights: [1, 1] } },
    };
    const duplicateAction = {
      ...validPack,
      actions: [
        {
          id: "wave",
          clips: ["breathe", "breathe"],
          priority: 1,
          interruptible: true,
        },
      ],
    };

    expect(validatePetPack(duplicateState, validManifest).success).toBe(false);
    expect(validatePetPack(duplicateAction, validManifest).success).toBe(false);
  });
});
