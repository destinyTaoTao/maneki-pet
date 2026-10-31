/**
 * 技能包清单 v1 校验（architecture §10.1，ADR-0002）：纯数据描述文件，
 * 不含可执行语义；脚本哈希逐文件核对由 CLI 在物化/安装时完成。
 * 路径规则沿用 §3.2：拒绝绝对路径与穿越；脚本必须位于 scripts/ 之下。
 */
export type ValidateResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface SkillPackScript {
  path: string;
  bytes: number;
  sha256: string;
}

export interface SkillPackManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  /** EverNook 已启用经验的回链（来源关系由外壳记录，账本无一等字段——ADR-0006）。 */
  experienceId: string;
  entry: "SKILL.md";
  description?: string;
  scripts: SkillPackScript[];
}

const ID_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkString(value: unknown, field: string, max: number, pattern?: RegExp): string | null {
  if (typeof value !== "string") return `${field} must be a string`;
  if (value.length === 0 || value.length > max) return `${field} length must be 1..${max}`;
  if (pattern && !pattern.test(value)) return `${field} does not match the required pattern`;
  return null;
}

/** 校验清单结构；文件哈希核对见 validateScriptHashes。 */
export function validateSkillPack(manifest: unknown): ValidateResult<SkillPackManifest> {
  if (!isRecord(manifest)) return { ok: false, reason: "manifest must be a JSON object" };
  for (const key of Object.keys(manifest)) {
    if (!["schemaVersion", "id", "name", "version", "experienceId", "entry", "description", "scripts"].includes(key)) {
      return { ok: false, reason: `unknown manifest field "${key}"` };
    }
  }
  if (manifest.schemaVersion !== 1) {
    return { ok: false, reason: `unsupported schemaVersion ${String(manifest.schemaVersion)}` };
  }
  for (const [field, value] of [
    ["id", manifest.id],
    ["name", manifest.name],
    ["version", manifest.version],
    ["experienceId", manifest.experienceId],
  ] as const) {
    const problem = checkString(value, field, field === "name" ? 80 : 100, field === "id" ? ID_PATTERN : field === "version" ? VERSION_PATTERN : undefined);
    if (problem) return { ok: false, reason: problem };
  }
  if (manifest.entry !== "SKILL.md") {
    return { ok: false, reason: 'entry must be "SKILL.md"' };
  }
  if (manifest.description !== undefined) {
    const problem = checkString(manifest.description, "description", 500);
    if (problem) return { ok: false, reason: problem };
  }
  if (!Array.isArray(manifest.scripts)) {
    return { ok: false, reason: "scripts must be an array" };
  }
  const scripts: SkillPackScript[] = [];
  const seen = new Set<string>();
  for (const raw of manifest.scripts) {
    if (!isRecord(raw)) return { ok: false, reason: "each script entry must be an object" };
    for (const key of Object.keys(raw)) {
      if (!["path", "bytes", "sha256"].includes(key)) {
        return { ok: false, reason: `unknown script field "${key}"` };
      }
    }
    const pathProblem = checkString(raw.path, "scripts[].path", 200);
    if (pathProblem) return { ok: false, reason: pathProblem };
    const path = raw.path as string;
    if (path.includes("\\") || path.startsWith("/") || path.split("/").includes("..")) {
      return { ok: false, reason: `scripts[].path "${path}" must be relative and stay inside scripts/` };
    }
    if (!path.startsWith("scripts/")) {
      return { ok: false, reason: `scripts[].path "${path}" must start with scripts/` };
    }
    if (seen.has(path)) return { ok: false, reason: `duplicate script path "${path}"` };
    seen.add(path);
    if (typeof raw.bytes !== "number" || !Number.isInteger(raw.bytes) || raw.bytes < 1 || raw.bytes > 10 * 1024 * 1024) {
      return { ok: false, reason: `scripts[].bytes must be an integer in 1..10485760` };
    }
    const hashProblem = checkString(raw.sha256, "scripts[].sha256", 64, SHA256_PATTERN);
    if (hashProblem) return { ok: false, reason: hashProblem };
    scripts.push({ path, bytes: raw.bytes as number, sha256: raw.sha256 as string });
  }
  const value: SkillPackManifest = {
    schemaVersion: 1,
    id: manifest.id as string,
    name: manifest.name as string,
    version: manifest.version as string,
    experienceId: manifest.experienceId as string,
    entry: "SKILL.md",
    ...(manifest.description !== undefined ? { description: manifest.description as string } : {}),
    scripts,
  };
  return { ok: true, value };
}

/** 物化/安装时核对：清单声明的哈希与实际计算结果逐文件一致。 */
export function validateScriptHashes(
  manifest: SkillPackManifest,
  computed: Record<string, { bytes: number; sha256: string }>,
): ValidateResult<true> {
  for (const script of manifest.scripts) {
    const actual = computed[script.path];
    if (!actual) return { ok: false, reason: `script "${script.path}" missing from computed hashes` };
    if (actual.bytes !== script.bytes || actual.sha256 !== script.sha256) {
      return { ok: false, reason: `script "${script.path}" content mismatch (expected ${script.bytes}B/${script.sha256.slice(0, 12)}…)` };
    }
  }
  for (const path of Object.keys(computed)) {
    // 入口 SKILL.md 与脚本同为安装时哈希对象；其余未声明文件拒绝。
    if (path !== manifest.entry && !manifest.scripts.some((script) => script.path === path)) {
      return { ok: false, reason: `computed file "${path}" is not declared in the manifest` };
    }
  }
  return { ok: true, value: true };
}
