/**
 * 元数据 JSON 与运营数据模板：Maneki 与 EverNook 共同的数据契约
 * （architecture §10.2；JSON Schema 见 platform-bilibili/schemas/）。
 * 大资产（视频/封面）不进 EverNook 账本，仅以路径/哈希元数据引用。
 */
import type { ValidateResult } from "@maneki-pet/core";

export interface PublishMetadata {
  schemaVersion: 1;
  platform: string;
  title: string;
  intro: string;
  tags: string[];
  video: { file: string; bytes: number; sha256: string; durationSeconds?: number };
  cover: { file: string; bytes: number; sha256: string };
  experienceId?: string;
  createdAt: string;
}

export interface OpsDataEntry {
  schemaVersion: 1;
  platform: string;
  videoId: string;
  date: string;
  plays: number;
  likes: number;
  comments: number;
  coins: number;
  shares: number;
  /** 恒为 "manual-export"：运营数据只来自人工导出，标注人工来源。 */
  source: "manual-export";
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknown(value: Record<string, unknown>, allowed: string[], label: string): string | null {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return `unknown ${label} field "${key}"`;
  }
  return null;
}

interface FileRef {
  file: string;
  bytes: number;
  sha256: string;
  durationSeconds?: number;
}

function fileRef(value: unknown, label: string): ValidateResult<FileRef> {
  if (!isRecord(value)) return { ok: false, reason: `${label} must be an object` };
  const problem = rejectUnknown(value, ["file", "bytes", "sha256", "durationSeconds"], label);
  if (problem) return { ok: false, reason: problem };
  if (typeof value.file !== "string" || value.file.length === 0) {
    return { ok: false, reason: `${label}.file must be a non-empty string` };
  }
  if (typeof value.bytes !== "number" || !Number.isInteger(value.bytes) || value.bytes < 1) {
    return { ok: false, reason: `${label}.bytes must be a positive integer` };
  }
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    return { ok: false, reason: `${label}.sha256 must be 64-hex` };
  }
  if (value.durationSeconds !== undefined && (typeof value.durationSeconds !== "number" || value.durationSeconds < 0)) {
    return { ok: false, reason: `${label}.durationSeconds must be a non-negative number` };
  }
  const fileRefValue: FileRef = {
    file: value.file,
    bytes: value.bytes,
    sha256: value.sha256,
    ...(value.durationSeconds !== undefined ? { durationSeconds: value.durationSeconds } : {}),
  };
  return { ok: true, value: fileRefValue };
}

function nonNegativeInt(value: unknown, field: string): string | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return `${field} must be a non-negative integer`;
  return null;
}

export function validateMetadataJson(value: unknown, platform: string): ValidateResult<PublishMetadata> {
  if (!isRecord(value)) return { ok: false, reason: "metadata must be a JSON object" };
  const problem = rejectUnknown(
    value,
    ["schemaVersion", "platform", "title", "intro", "tags", "video", "cover", "experienceId", "createdAt"],
    "metadata",
  );
  if (problem) return { ok: false, reason: problem };
  if (value.schemaVersion !== 1) return { ok: false, reason: `unsupported metadata schemaVersion ${String(value.schemaVersion)}` };
  if (value.platform !== platform) return { ok: false, reason: `metadata platform must be "${platform}"` };
  if (typeof value.title !== "string" || value.title.length === 0 || value.title.length > 80) {
    return { ok: false, reason: "title must be 1..80 characters (B站 limit)" };
  }
  if (typeof value.intro !== "string" || value.intro.length > 2000) {
    return { ok: false, reason: "intro must be at most 2000 characters" };
  }
  if (!Array.isArray(value.tags) || value.tags.length < 1 || value.tags.length > 10) {
    return { ok: false, reason: "tags must contain 1..10 items" };
  }
  for (const tag of value.tags) {
    if (typeof tag !== "string" || tag.length === 0 || tag.length > 20) {
      return { ok: false, reason: "each tag must be 1..20 characters" };
    }
  }
  const video = fileRef(value.video, "video");
  if (!video.ok) return video;
  const cover = fileRef(value.cover, "cover");
  if (!cover.ok) return cover;
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    return { ok: false, reason: "createdAt must be an ISO timestamp" };
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      platform,
      title: value.title,
      intro: value.intro,
      tags: value.tags as string[],
      video: video.value,
      cover: { file: cover.value.file, bytes: cover.value.bytes, sha256: cover.value.sha256 },
      ...(value.experienceId !== undefined ? { experienceId: value.experienceId as string } : {}),
      createdAt: value.createdAt,
    },
  };
}

export function validateOpsData(value: unknown, platform: string): ValidateResult<OpsDataEntry> {
  if (!isRecord(value)) return { ok: false, reason: "ops data must be a JSON object" };
  const problem = rejectUnknown(
    value,
    ["schemaVersion", "platform", "videoId", "date", "plays", "likes", "comments", "coins", "shares", "source"],
    "ops data",
  );
  if (problem) return { ok: false, reason: problem };
  if (value.schemaVersion !== 1) return { ok: false, reason: `unsupported ops schemaVersion ${String(value.schemaVersion)}` };
  if (value.platform !== platform) return { ok: false, reason: `ops platform must be "${platform}"` };
  if (typeof value.videoId !== "string" || value.videoId.length === 0 || value.videoId.length > 64) {
    return { ok: false, reason: "videoId must be 1..64 characters" };
  }
  if (typeof value.date !== "string" || !DATE_PATTERN.test(value.date)) {
    return { ok: false, reason: "date must be YYYY-MM-DD" };
  }
  const counters: Partial<Record<"plays" | "likes" | "comments" | "coins" | "shares", number>> = {};
  for (const field of ["plays", "likes", "comments", "coins", "shares"] as const) {
    const problem = nonNegativeInt(value[field], field);
    if (problem) return { ok: false, reason: problem };
    counters[field] = value[field] as number;
  }
  if (value.source !== "manual-export") {
    return { ok: false, reason: 'ops data source must be "manual-export"（人工导出标注）' };
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      platform,
      videoId: value.videoId,
      date: value.date,
      plays: counters.plays as number,
      likes: counters.likes as number,
      comments: counters.comments as number,
      coins: counters.coins as number,
      shares: counters.shares as number,
      source: "manual-export",
    },
  };
}
