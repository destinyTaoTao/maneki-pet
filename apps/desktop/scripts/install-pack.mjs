// 命令行动作包安装器：node scripts/install-pack.mjs <源包目录> [--packs-dir <目录>]
// 完整校验通过后按 id 原子切换安装；校验失败保留旧包并返回非零退出码。
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { installPack } from "./lib/pack-fs.mjs";
import packIds from "../config/builtin-packs.json" with { type: "json" };

const scriptRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { packsDir: join(scriptRoot, "public", "packs"), sourceDir: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--packs-dir") {
      args.packsDir = argv[index + 1];
      index += 1;
    } else if (value.startsWith("--packs-dir=")) {
      args.packsDir = value.slice("--packs-dir=".length);
    } else if (args.sourceDir === undefined) {
      args.sourceDir = value;
    } else {
      throw new Error(`Unexpected argument: ${value}`);
    }
  }
  if (!args.sourceDir) {
    throw new Error("Usage: node scripts/install-pack.mjs <source-pack-dir> [--packs-dir <dir>]");
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const sourceDir = resolve(args.sourceDir);
const packsDir = resolve(args.packsDir);
try {
  const result = installPack({ sourceDir, packsRoot: packsDir });
  console.log(`Installed pack ${result.id}@${result.version} -> ${packsDir}`);
  if (!packIds.includes(result.id)) {
    console.log(`Note: "${result.id}" is not in config/builtin-packs.json, add it to load in dev.`);
  }
} catch (error) {
  console.error(`Install failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
