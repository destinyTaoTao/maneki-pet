import { validatePetPack } from "@maneki-pet/core";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
  for (const entry of result.value.manifest.files) {
    const path = resolve(packRoot, entry.path);
    if (!path.startsWith(`${packRoot}${sep}`)) {
      throw new Error(`${packId}: asset escapes pack directory: ${entry.path}`);
    }
    const bytes = readFileSync(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== entry.bytes || sha256 !== entry.sha256) {
      throw new Error(`${packId}: integrity mismatch: ${entry.path}`);
    }
  }
}

console.log(`Validated ${packIds.length} pet packs`);
