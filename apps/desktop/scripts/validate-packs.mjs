// 构建期内置包校验：Schema/语义校验走 @maneki-pet/core，真实文件层校验走共享 pack-fs。
import { validatePetPack } from "@maneki-pet/core";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyPackOnDisk } from "./lib/pack-fs.mjs";
import packIds from "../config/builtin-packs.json" with { type: "json" };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--packs-dir" || !args[1])) {
  throw new Error("Usage: node scripts/validate-packs.mjs [--packs-dir <dir>]");
}
const packsRoot = args.length ? resolve(args[1]) : join(root, "public", "packs");

for (const packId of packIds) {
  const packRoot = resolve(packsRoot, packId);
  if (!existsSync(join(packRoot, "pet-pack.json")) || !existsSync(join(packRoot, "assets.manifest.json"))) {
    throw new Error(`Missing prepared pack ${packId} in ${packsRoot}. Import the versioned asset directory with node scripts/install-pack.mjs <source-pack-dir> --packs-dir <dir>. For development placeholders only, run generate:packs.`);
  }
  const pack = JSON.parse(readFileSync(join(packRoot, "pet-pack.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(packRoot, "assets.manifest.json"), "utf8"));
  const result = validatePetPack(pack, manifest);
  if (!result.success) {
    throw new Error(`${packId}: ${JSON.stringify(result.errors)}`);
  }
  if (result.value.pack.id !== packId) throw new Error(`Pack id must match directory ${packId}`);
  const errors = verifyPackOnDisk(packRoot, result.value.pack, result.value.manifest);
  if (errors.length > 0) {
    throw new Error(`${packId}: ${errors.join("; ")}`);
  }
}

console.log(`Validated ${packIds.length} pet packs`);
