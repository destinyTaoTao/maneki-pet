// 构建期内置包校验：Schema/语义校验走 @maneki-pet/core，真实文件层校验走共享 pack-fs。
import { validatePetPack } from "@maneki-pet/core";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyPackOnDisk } from "./lib/pack-fs.mjs";
import packIds from "../config/builtin-packs.json" with { type: "json" };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const packId of packIds) {
  const packRoot = resolve(root, "public", "packs", packId);
  const pack = JSON.parse(readFileSync(join(packRoot, "pet-pack.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(packRoot, "assets.manifest.json"), "utf8"));
  const result = validatePetPack(pack, manifest);
  if (!result.success) {
    throw new Error(`${packId}: ${JSON.stringify(result.errors)}`);
  }
  const errors = verifyPackOnDisk(packRoot, result.value.pack, result.value.manifest);
  if (errors.length > 0) {
    throw new Error(`${packId}: ${errors.join("; ")}`);
  }
}

console.log(`Validated ${packIds.length} pet packs`);
