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
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  closeSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/**
 * 对包目录做真实文件层校验：重新计算每个清单项的哈希与大小，
 * 并拒绝符号链接/junction 逃逸与清单之外的素材文件。
 * 返回错误字符串列表；为空表示通过。
 */
export function verifyPackOnDisk(packRoot, pack, manifest) {
  const errors = [];
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
    const bytes = readAllBytes(absolute);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== entry.bytes || sha256 !== entry.sha256) {
      errors.push(`Integrity mismatch for ${entry.path}`);
    }
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

function readAllBytes(absolute) {
  // statSync 在 lstat/realpath 确认是包内普通文件之后执行，不存在跟随逃逸。
  const { size } = statSync(absolute);
  const buffer = Buffer.alloc(size);
  const handle = openSync(absolute, "r");
  try {
    let offset = 0;
    while (offset < size) {
      const read = readSync(handle, buffer, offset, size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
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
  const pack = readJson(join(sourceDir, "pet-pack.json"));
  const manifest = readJson(join(sourceDir, "assets.manifest.json"));
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
    copyFileSync(join(sourceDir, "pet-pack.json"), join(staging, "pet-pack.json"));
    copyFileSync(join(sourceDir, "assets.manifest.json"), join(staging, "assets.manifest.json"));
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

function readJson(absolute) {
  return JSON.parse(readFileSync(absolute, "utf8"));
}

let suffixCounter = 0;
function defaultSuffix() {
  suffixCounter += 1;
  return `${process.pid}-${suffixCounter}`;
}
