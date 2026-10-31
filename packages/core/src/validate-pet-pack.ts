// 动作包 v1 结构校验：手写实现（见 architecture §9 选型修订）。
// 运行环境（桌面壳 CSP）禁止 new Function/eval，因此不使用运行时 JSON Schema 编译器；
// 字段集合、模式与上限与 v1 契约一一对应，行为由测试逐条覆盖。
import { petStates } from "./pet-pack.js";
import type { AssetManifest, PetPack } from "./pet-pack.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { success: true; value: T }
  | { success: false; errors: ValidationIssue[] };

export interface ValidatedPetPack {
  pack: PetPack;
  manifest: AssetManifest;
}

const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CLIP_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PATH_LENGTH = 240;
const MAX_FILES = 128;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const VIDEO_MIME_TYPES = new Set(["video/webm", "video/quicktime"]);
const IMAGE_MIME_TYPES = new Set(["image/png", "image/webp"]);

type Issues = ValidationIssue[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function push(issues: Issues, path: string, message: string): void {
  issues.push({ path, message });
}

/** 校验对象只包含给定字段；返回多余字段列表。 */
function unknownKeys(value: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function validatePackStructure(pack: unknown): Issues {
  const issues: Issues = [];
  const base = "pack";
  if (!isRecord(pack)) {
    push(issues, base, "must be object");
    return issues;
  }
  const required = ["schemaVersion", "id", "name", "version", "permissions", "clips", "states", "actions"];
  for (const key of required) {
    if (!(key in pack)) {
      push(issues, `${base}/${key}`, `must have required property '${key}'`);
    }
  }
  for (const key of unknownKeys(pack, required)) {
    push(issues, `${base}/${key}`, "must NOT have additional properties");
  }
  if (pack.schemaVersion !== 1) {
    push(issues, `${base}/schemaVersion`, "must be equal to constant 1");
  }
  if (!isString(pack.id) || !PACK_ID_PATTERN.test(pack.id)) {
    push(issues, `${base}/id`, `must match pattern ${PACK_ID_PATTERN.source}`);
  }
  if (!isString(pack.name) || pack.name.length < 1 || pack.name.length > 80) {
    push(issues, `${base}/name`, "must be a string of 1-80 characters");
  }
  if (!isString(pack.version) || !VERSION_PATTERN.test(pack.version)) {
    push(issues, `${base}/version`, `must match pattern ${VERSION_PATTERN.source}`);
  }
  if (!Array.isArray(pack.permissions) || pack.permissions.length > 0) {
    push(issues, `${base}/permissions`, "must be an empty array");
  }
  validateClips(pack.clips, issues);
  validateStates(pack.states, issues);
  validateActions(pack.actions, issues);
  return issues;
}

function validateClips(clips: unknown, issues: Issues): void {
  const base = "pack/clips";
  if (!isRecord(clips)) {
    push(issues, base, "must be object");
    return;
  }
  const keys = Object.keys(clips);
  if (keys.length < 1) {
    push(issues, base, "must have at least 1 property");
  }
  for (const key of keys) {
    if (!CLIP_ID_PATTERN.test(key)) {
      push(issues, `${base}/${key}`, `property name must match pattern ${CLIP_ID_PATTERN.source}`);
    }
    validateClipSources(clips[key], `${base}/${key}/sources`, issues);
  }
}

function validateClipSources(value: unknown, base: string, issues: Issues): void {
  if (!isRecord(value)) {
    push(issues, base.slice(0, base.lastIndexOf("/")), "must be object");
    return;
  }
  for (const key of unknownKeys(value, ["sources"])) {
    push(issues, `${base.slice(0, base.lastIndexOf("/"))}/${key}`, "must NOT have additional properties");
  }
  const sources = value.sources;
  if (!Array.isArray(sources) || sources.length < 1) {
    push(issues, base, "must be an array with at least 1 item");
    return;
  }
  sources.forEach((source, index) => {
    validateSource(source, `${base}/${index}`, issues);
  });
}

function validateSource(source: unknown, base: string, issues: Issues): void {
  if (!isRecord(source)) {
    push(issues, base, "must be object");
    return;
  }
  const renderer = source.renderer;
  if (renderer === "video-alpha") {
    validateSourceFields(source, base, issues, [...VIDEO_MIME_TYPES], false);
  } else if (renderer === "spritesheet") {
    validateSourceFields(source, base, issues, [...IMAGE_MIME_TYPES], true);
  } else {
    push(issues, `${base}/renderer`, "must match exactly one schema in oneOf");
    return;
  }
}

function validateSourceFields(
  source: Record<string, unknown>,
  base: string,
  issues: Issues,
  mimeTypes: string[],
  spritesheet: boolean,
): void {
  const allowed = spritesheet
    ? ["renderer", "path", "mimeType", "frameWidth", "frameHeight", "frameCount", "framesPerSecond"]
    : ["renderer", "path", "mimeType"];
  for (const key of unknownKeys(source, allowed)) {
    push(issues, `${base}/${key}`, "must NOT have additional properties");
  }
  if (!isString(source.path) || source.path.length < 1 || source.path.length > MAX_PATH_LENGTH) {
    push(issues, `${base}/path`, `must be a string of 1-${MAX_PATH_LENGTH} characters`);
  }
  if (!isString(source.mimeType) || !mimeTypes.includes(source.mimeType)) {
    push(issues, `${base}/mimeType`, `must be one of ${mimeTypes.join(", ")}`);
  }
  if (spritesheet) {
    for (const key of ["frameWidth", "frameHeight", "frameCount"]) {
      if (!isInteger(source[key]) || (source[key] as number) < 1) {
        push(issues, `${base}/${key}`, "must be an integer of at least 1");
      }
    }
    if (!isFiniteNumber(source.framesPerSecond) || (source.framesPerSecond as number) <= 0) {
      push(issues, `${base}/framesPerSecond`, "must be a finite number greater than 0");
    }
  }
}

function validateStates(states: unknown, issues: Issues): void {
  const base = "pack/states";
  if (!isRecord(states)) {
    push(issues, base, "must be object");
    return;
  }
  const allowed = [...petStates];
  for (const key of unknownKeys(states, allowed)) {
    push(issues, `${base}/${key}`, "must NOT have additional properties");
  }
  if (!("idle" in states)) {
    push(issues, `${base}`, "must have required property 'idle'");
  }
  for (const state of allowed) {
    if (state in states) {
      validateStateAnimation(states[state], `${base}/${state}`, issues);
    }
  }
}

function validateStateAnimation(animation: unknown, base: string, issues: Issues): void {
  if (!isRecord(animation)) {
    push(issues, base, "must be object");
    return;
  }
  for (const key of unknownKeys(animation, ["clips", "weights"])) {
    push(issues, `${base}/${key}`, "must NOT have additional properties");
  }
  if (!Array.isArray(animation.clips) || animation.clips.length < 1 || !isStringArray(animation.clips)) {
    push(issues, `${base}/clips`, "must be an array of clip ids with at least 1 item");
  } else {
    animation.clips.forEach((clipId, index) => {
      if (!CLIP_ID_PATTERN.test(clipId)) {
        push(issues, `${base}/clips/${index}`, `must match pattern ${CLIP_ID_PATTERN.source}`);
      }
    });
  }
  if (!Array.isArray(animation.weights) || animation.weights.length < 1) {
    push(issues, `${base}/weights`, "must be an array with at least 1 item");
    return;
  }
  animation.weights.forEach((weight, index) => {
    if (!isFiniteNumber(weight) || weight < 0) {
      push(issues, `${base}/weights/${index}`, "must be a finite non-negative number");
    }
  });
}

function validateActions(actions: unknown, issues: Issues): void {
  const base = "pack/actions";
  if (!Array.isArray(actions)) {
    push(issues, base, "must be array");
    return;
  }
  actions.forEach((action, index) => {
    const actionBase = `${base}/${index}`;
    if (!isRecord(action)) {
      push(issues, actionBase, "must be object");
      return;
    }
    const allowed = ["id", "clips", "priority", "interruptible"];
    for (const key of unknownKeys(action, allowed)) {
      push(issues, `${actionBase}/${key}`, "must NOT have additional properties");
    }
    if (!isString(action.id) || !CLIP_ID_PATTERN.test(action.id)) {
      push(issues, `${actionBase}/id`, `must match pattern ${CLIP_ID_PATTERN.source}`);
    }
    if (!Array.isArray(action.clips) || action.clips.length < 1 || !isStringArray(action.clips)) {
      push(issues, `${actionBase}/clips`, "must be an array of clip ids with at least 1 item");
    }
    if (!isInteger(action.priority) || action.priority < 0) {
      push(issues, `${actionBase}/priority`, "must be a non-negative integer");
    }
    if (typeof action.interruptible !== "boolean") {
      push(issues, `${actionBase}/interruptible`, "must be boolean");
    }
  });
}

function validateManifestStructure(manifest: unknown): Issues {
  const issues: Issues = [];
  const base = "manifest";
  if (!isRecord(manifest)) {
    push(issues, base, "must be object");
    return issues;
  }
  const required = ["schemaVersion", "algorithm", "files"];
  for (const key of required) {
    if (!(key in manifest)) {
      push(issues, `${base}/${key}`, `must have required property '${key}'`);
    }
  }
  for (const key of unknownKeys(manifest, required)) {
    push(issues, `${base}/${key}`, "must NOT have additional properties");
  }
  if (manifest.schemaVersion !== 1) {
    push(issues, `${base}/schemaVersion`, "must be equal to constant 1");
  }
  if (manifest.algorithm !== "sha256") {
    push(issues, `${base}/algorithm`, "must be equal to constant 'sha256'");
  }
  const files = manifest.files;
  if (!Array.isArray(files)) {
    push(issues, `${base}/files`, "must be array");
    return issues;
  }
  if (files.length > MAX_FILES) {
    push(issues, `${base}/files`, `must NOT have more than ${MAX_FILES} items`);
  }
  files.forEach((entry, index) => {
    const entryBase = `${base}/files/${index}`;
    if (!isRecord(entry)) {
      push(issues, entryBase, "must be object");
      return;
    }
    const allowed = ["path", "sha256", "bytes"];
    for (const key of unknownKeys(entry, allowed)) {
      push(issues, `${entryBase}/${key}`, "must NOT have additional properties");
    }
    if (!isString(entry.path) || entry.path.length < 1 || entry.path.length > MAX_PATH_LENGTH) {
      push(issues, `${entryBase}/path`, `must be a string of 1-${MAX_PATH_LENGTH} characters`);
    }
    if (!isString(entry.sha256) || !SHA256_PATTERN.test(entry.sha256)) {
      push(issues, `${entryBase}/sha256`, `must match pattern ${SHA256_PATTERN.source}`);
    }
    if (!isInteger(entry.bytes) || (entry.bytes as number) < 0 || (entry.bytes as number) > MAX_FILE_BYTES) {
      push(issues, `${entryBase}/bytes`, `must be an integer between 0 and ${MAX_FILE_BYTES}`);
    }
  });
  return issues;
}

export function validatePetPack(
  pack: unknown,
  manifest: unknown,
): ValidationResult<ValidatedPetPack> {
  const packIssues = validatePackStructure(pack);
  const manifestIssues = validateManifestStructure(manifest);
  if (packIssues.length > 0 || manifestIssues.length > 0) {
    return { success: false, errors: [...packIssues, ...manifestIssues] };
  }
  // 结构校验已保证形状，这里收窄类型以复用语义检查。
  const validPack = pack as PetPack;
  const validManifest = manifest as AssetManifest;
  const semanticIssues = [
    ...validatePackSemantics(validPack),
    ...validateManifestSemantics(validPack, validManifest),
  ];
  if (semanticIssues.length > 0) {
    return { success: false, errors: semanticIssues };
  }
  return { success: true, value: { pack: validPack, manifest: validManifest } };
}

function validatePackSemantics(pack: PetPack): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [state, animation] of Object.entries(pack.states)) {
    if (!animation) {
      continue;
    }
    const stateClipIds = new Set<string>();
    animation.clips.forEach((clipId, index) => {
      if (!pack.clips[clipId]) {
        push(issues, `pack/states/${state}/clips/${index}`, "Referenced clip does not exist");
      }
      if (stateClipIds.has(clipId)) {
        push(issues, `pack/states/${state}/clips/${index}`, "Clip references must be unique");
      }
      stateClipIds.add(clipId);
    });
    if (animation.clips.length !== animation.weights.length) {
      push(issues, `pack/states/${state}/weights`, "Weights must match the clip count");
    }
    if (animation.weights.reduce((sum, weight) => sum + weight, 0) <= 0) {
      push(issues, `pack/states/${state}/weights`, "Weights must have a positive sum");
    }
  }
  for (const [clipId, clip] of Object.entries(pack.clips)) {
    clip.sources.forEach((source, index) => {
      if (!isSafeAssetPath(source.path)) {
        push(issues, `pack/clips/${clipId}/sources/${index}/path`, "Asset path must be a safe relative path");
      }
    });
  }
  const actionIds = new Set<string>();
  pack.actions.forEach((action, actionIndex) => {
    if (actionIds.has(action.id)) {
      push(issues, `pack/actions/${actionIndex}/id`, "Action IDs must be unique");
    }
    actionIds.add(action.id);
    const actionClipIds = new Set<string>();
    action.clips.forEach((clipId, clipIndex) => {
      if (!pack.clips[clipId]) {
        push(issues, `pack/actions/${actionIndex}/clips/${clipIndex}`, "Referenced clip does not exist");
      }
      if (actionClipIds.has(clipId)) {
        push(issues, `pack/actions/${actionIndex}/clips/${clipIndex}`, "Clip references must be unique");
      }
      actionClipIds.add(clipId);
    });
  });
  return issues;
}

function validateManifestSemantics(
  pack: PetPack,
  manifest: AssetManifest,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sourcePaths = new Set(
    Object.values(pack.clips).flatMap((clip) => clip.sources.map((source) => source.path)),
  );
  const entryPaths = new Set<string>();
  manifest.files.forEach((entry, index) => {
    if (entryPaths.has(entry.path)) {
      push(issues, `manifest/files/${index}/path`, "Asset paths must be unique");
    }
    entryPaths.add(entry.path);
    if (!isSafeAssetPath(entry.path)) {
      push(issues, `manifest/files/${index}/path`, "Asset path must be a safe relative path");
    }
    if (!sourcePaths.has(entry.path)) {
      push(issues, `manifest/files/${index}/path`, "Manifest entry is not referenced by a clip");
    }
  });
  for (const path of sourcePaths) {
    if (!entryPaths.has(path)) {
      push(issues, "manifest/files", `Missing manifest entry for ${path}`);
    }
  }
  const totalBytes = manifest.files.reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    push(issues, "manifest/files", "Asset manifest exceeds the 256 MiB total size limit");
  }
  return issues;
}

function isSafeAssetPath(path: string): boolean {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes(":") ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path === "pet-pack.json" ||
    path === "assets.manifest.json"
  ) {
    return false;
  }
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
