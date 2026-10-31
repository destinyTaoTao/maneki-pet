/**
 * 打包 Runtime 供 Tauri 安装器分发（M2 出口项：安装包无须用户另装 Node）：
 * 1. esbuild 把 CLI（含 @maneki-pet/core）打包成单文件 JS
 * 2. 把 Node 运行时本身复制为带 target triple 的 sidecar 二进制
 * 产物进入 src-tauri 的 externalBin / resources 位置，随安装器分发；
 * 均为可重建产物，不入库（.gitignore）。
 */
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopTauri = join(runtimeRoot, "..", "..", "apps", "desktop", "src-tauri");

const triple = `${process.arch === "x64" ? "x86_64" : process.arch}-pc-windows-msvc`;
const resourcesDir = join(desktopTauri, "resources");
const binariesDir = join(desktopTauri, "binaries");

mkdirSync(resourcesDir, { recursive: true });
mkdirSync(binariesDir, { recursive: true });

await build({
  entryPoints: [join(runtimeRoot, "src", "cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(resourcesDir, "maneki-runtime-bundle.js"),
  external: ["node:*"],
  legalComments: "none",
  logLevel: "info",
});

copyFileSync(process.execPath, join(binariesDir, `maneki-runtime-${triple}.exe`));
console.log(`runtime bundle ready: resources/maneki-runtime-bundle.js + binaries/maneki-runtime-${triple}.exe (node ${process.version})`);
