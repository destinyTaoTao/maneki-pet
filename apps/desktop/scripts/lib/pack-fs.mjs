// 动作包真实文件层校验与安装：只做 IO 与字节校验，Schema/语义校验一律复用 @maneki-pet/core。
import { validatePetPack } from "@maneki-pet/core";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  closeSync,
  fstatSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { verifyMedia } from "./verify-media.mjs";

/**
 * 对包目录做真实文件层校验：重新计算每个清单项的哈希与大小，
 * 并拒绝符号链接/junction 逃逸与清单之外的素材文件。
 * 返回错误字符串列表；为空表示通过。
 */
export function verifyPackOnDisk(packRoot, pack, manifest) {
  const errors = [];
  let totalBytes = 0;
  const realPackRoot = realpathSync(packRoot);
  const referenced = new Set(
    Object.values(pack.clips).flatMap((clip) => clip.sources.map((source) => source.path)),
  );
  const declared = new Set(manifest.files.map((entry) => entry.path));
  for (const entry of manifest.files) {
    const absolute = resolve(packRoot, entry.path);
    if (!absolute.startsWith(`${resolve(packRoot)}${sep}`)) {
      errors.push(`Asset path escapes pack directory: ${entry.path}`);
      continue;
    }
    let stats;
    try {
      stats = lstatSync(absolute);
    } catch {
      errors.push(`Missing asset file: ${entry.path}`);
      continue;
    }
    if (stats.isSymbolicLink()) {
      errors.push(`Asset is a symbolic link: ${entry.path}`);
      continue;
    }
    if (!stats.isFile()) {
      errors.push(`Asset is not a regular file: ${entry.path}`);
      continue;
    }
    // realpath 解析中间目录里的 junction/符号链接，防止经父目录逃逸。
    try {
      const realAbsolute = realpathSync(absolute);
      if (!realAbsolute.startsWith(`${realPackRoot}${sep}`)) {
        errors.push(`Asset resolves outside the pack directory: ${entry.path}`);
        continue;
      }
    } catch {
      errors.push(`Asset path cannot be resolved: ${entry.path}`);
      continue;
    }
    totalBytes += stats.size;
    if (stats.size !== entry.bytes || stats.size > 64 * 1024 * 1024 || totalBytes > 256 * 1024 * 1024) {
      errors.push(`Integrity mismatch (byte size or byte limit) for ${entry.path}`);
      continue;
    }
    let sha256;
    try { sha256 = hashAsset(absolute, stats); }
    catch { errors.push(`Integrity mismatch (file changed during read) for ${entry.path}`); continue; }
    if (sha256 !== entry.sha256) {
      errors.push(`Integrity mismatch for ${entry.path}`);
      continue;
    }
    try {
      verifyMedia(absolute, Object.values(pack.clips).flatMap((clip) => clip.sources).filter((source) => source.path === entry.path));
    } catch (error) { errors.push(`${entry.path}: ${error.message}`); }
  }
  // assets 目录里的其他文件必须登记在清单中，防止夹带未声明内容。
  for (const relative of listAssetFiles(join(packRoot, "assets"), "assets")) {
    const normalized = relative.split("\\").join("/");
    if (!declared.has(normalized)) {
      errors.push(`Unmanifested asset file: ${normalized}`);
    }
  }
  for (const path of referenced) {
    if (!declared.has(path)) {
      errors.push(`Missing manifest entry for ${path}`);
    }
  }
  return errors;
}

function hashAsset(absolute, expected) {
  const buffer = Buffer.alloc(64 * 1024);
  const hash = createHash("sha256");
  const handle = openSync(absolute, "r");
  try {
    const opened = fstatSync(handle);
    if (!opened.isFile() || opened.size !== expected.size || opened.ino !== expected.ino || opened.dev !== expected.dev) throw new Error("asset changed before read");
    let offset = 0;
    while (offset < expected.size) {
      const read = readSync(handle, buffer, 0, Math.min(buffer.length, expected.size - offset), offset);
      if (read === 0) throw new Error("asset truncated");
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
    if (readSync(handle, buffer, 0, 1, offset) !== 0) throw new Error("asset grew");
    return hash.digest("hex");
  } finally {
    closeSync(handle);
  }
}

function listAssetFiles(dir, prefix = "") {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      results.push(relative);
      continue;
    }
    if (entry.isDirectory()) {
      results.push(...listAssetFiles(join(dir, entry.name), relative));
    } else if (entry.isFile()) {
      results.push(relative);
    }
  }
  return results;
}

/**
 * 校验并把源包安装到 packsRoot/<id>：先写入独立 staging 目录并复核，
 * 通过后原子切换；已有旧版本时失败则回滚保留旧包。
 */
export function installPack({ sourceDir, packsRoot, randomSuffix = defaultSuffix }) {
  const pack = readPackJson(join(sourceDir, "pet-pack.json"));
  const manifest = readPackJson(join(sourceDir, "assets.manifest.json"));
  const validated = validatePetPack(pack, manifest);
  if (!validated.success) {
    throw new Error(`Pack failed validation: ${JSON.stringify(validated.errors)}`);
  }
  const { pack: validPack, manifest: validManifest } = validated.value;
  const diskErrors = verifyPackOnDisk(sourceDir, validPack, validManifest);
  if (diskErrors.length > 0) {
    throw new Error(`Pack failed on-disk verification: ${diskErrors.join("; ")}`);
  }

  const id = validPack.id;
  if (!id || /[\\/:]/.test(id) || id === "." || id === "..") {
    throw new Error(`Unsafe pack id: ${id}`);
  }
  mkdirSync(packsRoot, { recursive: true });
  const target = join(packsRoot, id);
  const staging = join(packsRoot, `.staging-${id}-${randomSuffix()}`);
  let backup;
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(join(staging, "assets"), { recursive: true });
    // 固化已校验快照，不能再次复制可能已被替换的源 JSON。
    writeFileSync(join(staging, "pet-pack.json"), JSON.stringify(validPack));
    writeFileSync(join(staging, "assets.manifest.json"), JSON.stringify(validManifest));
    for (const entry of validManifest.files) {
      const destination = join(staging, entry.path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(sourceDir, entry.path), destination);
    }
    // 对 staging 副本再校验一次，防止复制过程中内容变化。
    const copyErrors = verifyPackOnDisk(staging, validPack, validManifest);
    if (copyErrors.length > 0) {
      throw new Error(`Staged copy failed verification: ${copyErrors.join("; ")}`);
    }
    if (exists(target)) {
      backup = join(packsRoot, `.backup-${id}-${randomSuffix()}`);
      renameSync(target, backup);
    }
    try {
      renameSync(staging, target);
    } catch (error) {
      if (backup) {
        renameSync(backup, target);
        backup = undefined;
      }
      throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (backup && exists(target)) {
      rmSync(backup, { recursive: true, force: true });
    }
  }
  return { id, version: validPack.version };
}

function exists(absolute) {
  try {
    lstatSync(absolute);
    return true;
  } catch {
    return false;
  }
}

export function readPackJson(absolute) {
  const expected = lstatSync(absolute);
  if (!expected.isFile() || expected.isSymbolicLink() || expected.size > 1024 * 1024) throw new Error("Pack JSON file type or size exceeds limit");
  const handle = openSync(absolute, "r");
  try {
    const opened = fstatSync(handle);
    if (!opened.isFile() || opened.size !== expected.size || opened.dev !== expected.dev || opened.ino !== expected.ino) throw new Error("Pack JSON changed before read");
    const buffer = Buffer.alloc(expected.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = readSync(handle, buffer, offset, buffer.length - offset, offset);
      if (!bytes) break;
      offset += bytes;
    }
    if (offset !== expected.size) throw new Error("Pack JSON changed during bounded read");
    return JSON.parse(buffer.subarray(0, offset).toString("utf8"));
  } finally { closeSync(handle); }
}

let suffixCounter = 0;
function defaultSuffix() {
  suffixCounter += 1;
  return `${process.pid}-${suffixCounter}`;
}
