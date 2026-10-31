export const petStates = [
  "idle",
  "thinking",
  "working",
  "waiting_input",
  "celebrating",
  "error",
  "sleeping",
] as const;

export type PetState = (typeof petStates)[number];

export interface VideoAlphaSource {
  renderer: "video-alpha";
  path: string;
  mimeType: "video/webm" | "video/quicktime";
}

export interface SpritesheetSource {
  renderer: "spritesheet";
  path: string;
  mimeType: "image/png" | "image/webp";
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  framesPerSecond: number;
}

export type ClipSource = VideoAlphaSource | SpritesheetSource;

export interface PetClip {
  sources: ClipSource[];
}

export interface StateAnimation {
  clips: string[];
  weights: number[];
}

export interface PetAction {
  id: string;
  clips: string[];
  priority: number;
  interruptible: boolean;
}

export interface PetPack {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  permissions: [];
  clips: Record<string, PetClip>;
  states: Partial<Record<PetState, StateAnimation>> & { idle: StateAnimation };
  actions: PetAction[];
}

export interface AssetManifestEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface AssetManifest {
  schemaVersion: 1;
  algorithm: "sha256";
  files: AssetManifestEntry[];
}
