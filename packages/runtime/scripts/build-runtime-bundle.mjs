/**
 * 打包 Runtime 供 Tauri 安装器分发（M2 出口项：安装包无须用户另装 Node）：
 * 1. esbuild 把 CLI（含 @maneki-pet/core）打包成单文件 JS
 * 2. 把 Node 运行时本身复制为带 target triple 的 sidecar 二进制
 * 产物进入 src-tauri 的 externalBin / resources 位置，随安装器分发；
 * 均为可重建产物，不入库（.gitignore）。
 */
import { build } from "esbuild";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopTauri = join(
  runtimeRoot,
  "..",
  "..",
  "apps",
  "desktop",
  "src-tauri",
);

if (
  process.platform !== "win32" ||
  process.arch !== "x64" ||
  process.version !== "v24.12.0"
)
  throw new Error(
    "Windows preview packaging requires Node 24.12.0 x64; TypeScript-only builds are unaffected.",
  );
const triple = "x86_64-pc-windows-msvc";
const resourcesDir = join(desktopTauri, "resources");
const binariesDir = join(desktopTauri, "binaries");

mkdirSync(resourcesDir, { recursive: true });
mkdirSync(binariesDir, { recursive: true });

const result = await build({
  entryPoints: [join(runtimeRoot, "src", "cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(resourcesDir, "maneki-runtime-bundle.js"),
  external: ["node:*"],
  legalComments: "none",
  logLevel: "info",
  metafile: true,
});

const licenses = join(resourcesDir, "licenses");
mkdirSync(licenses, { recursive: true });
copyFileSync(
  join(runtimeRoot, "notices/Node-v24.12.0-LICENSE"),
  join(licenses, "Node-LICENSE.txt"),
);
const roots = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  let candidate = dirname(resolve(input));
  if (!candidate.includes("node_modules")) continue;
  while (dirname(candidate) !== candidate) {
    const metadata = join(candidate, "package.json");
    if (
      existsSync(metadata) &&
      JSON.parse(readFileSync(metadata, "utf8")).name
    ) {
      roots.add(candidate);
      break;
    }
    candidate = dirname(candidate);
  }
}
const notices = [...roots].sort().map((root) => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const files = readdirSync(root).filter((name) =>
    /^(LICENSE|LICENCE|COPYING|NOTICE)([.\-_]|$)/i.test(name),
  );
  if (!files.length)
    throw new Error(`Missing redistribution notice for ${pkg.name}`);
  return `\n===== ${pkg.name}@${pkg.version} (${pkg.license ?? "see notice"}) =====\n${files.map((name) => readFileSync(join(root, name), "utf8")).join("\n")}`;
});
writeFileSync(join(licenses, "Runtime-THIRD-PARTY.txt"), notices.join("\n"));

copyFileSync(
  process.execPath,
  join(binariesDir, `maneki-runtime-${triple}.exe`),
);
console.log(
  `runtime bundle ready: resources/maneki-runtime-bundle.js + binaries/maneki-runtime-${triple}.exe (node ${process.version})`,
);
