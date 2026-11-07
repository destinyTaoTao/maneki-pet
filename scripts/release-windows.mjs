import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const hash = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
export async function releaseInputs() {
  const { validatePetPack } = await import("../packages/core/dist/index.js");
  const { verifyPackOnDisk } = await import(
    "../apps/desktop/scripts/lib/pack-fs.mjs"
  );
  const tauri = read("apps/desktop/src-tauri/tauri.conf.json"),
    desktop = read("apps/desktop/package.json"),
    runtime = read("packages/runtime/package.json"),
    plugin = read("apps/dsh-plugin/package.json");
  const version = tauri.version;
  if (
    desktop.version !== version ||
    runtime.version !== version ||
    !readFileSync(
      join(root, "apps/desktop/src-tauri/Cargo.toml"),
      "utf8",
    ).includes(`version = "${version}"`) ||
    !readFileSync(
      join(root, "packages/runtime/src/release-version.ts"),
      "utf8",
    ).includes(`"${version}"`)
  )
    throw new Error("Release versions disagree");
  if (
    desktop.devDependencies["@tauri-apps/cli"] !== "2.12.4" ||
    read("apps/desktop/node_modules/@tauri-apps/cli/package.json").version !==
      "2.12.4"
  )
    throw new Error(
      "Review the pinned NSIS template before changing Tauri CLI",
    );
  const delivery = read(
      "apps/desktop/recipes/orange-catgirl-delivery-v1.1.0.json",
    ),
    packRoot = join(root, "apps/desktop/public/packs/xiaozhao-default");
  if (
    hash(join(packRoot, "pet-pack.json")) !== delivery.packDescriptorSha256 ||
    hash(join(packRoot, "assets.manifest.json")) !==
      delivery.assetsManifestSha256 ||
    hash(join(root, "apps/desktop/public/fallback.png")) !==
      delivery.fallbackSha256
  )
    throw new Error(
      "Approved default pack is required; development placeholders cannot ship",
    );
  for (const id of read("apps/desktop/config/builtin-packs.json")) {
    const path = join(root, "apps/desktop/public/packs", id),
      pack = JSON.parse(readFileSync(join(path, "pet-pack.json"), "utf8")),
      manifest = JSON.parse(
        readFileSync(join(path, "assets.manifest.json"), "utf8"),
      );
    const checked = validatePetPack(pack, manifest);
    if (!checked.success) throw new Error(`Invalid built-in pack: ${id}`);
    const errors = verifyPackOnDisk(
      path,
      checked.value.pack,
      checked.value.manifest,
    );
    if (errors.length)
      throw new Error(`Invalid built-in media ${id}: ${errors.join("; ")}`);
  }
  return { version, pluginVersion: plugin.version };
}
async function main() {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    process.version !== "v24.12.0"
  )
    throw new Error("Release requires Windows x64 / Node 24.12.0");
  const manager = process.env.npm_execpath;
  if (!manager || !existsSync(manager))
    throw new Error("Run with pnpm release:windows");
  const run = (args) =>
    execFileSync(process.execPath, [manager, ...args], {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
    });
  run(["-r", "build"]);
  const { version, pluginVersion } = await releaseInputs();
  run(["-r", "test"]);
  run(["-r", "typecheck"]);
  run([
    "--filter",
    "@maneki-pet/desktop",
    "tauri",
    "build",
    "--bundles",
    "nsis",
  ]);
  const destination = join(
    root,
    "dist/releases",
    `maneki-${version}-windows-x64`,
  );
  if (existsSync(destination))
    throw new Error(
      "Release directory already exists; move it aside before rebuilding",
    );
  mkdirSync(destination, { recursive: true });
  const bundle = join(
    root,
    "apps/desktop/src-tauri/target/release/bundle/nsis",
    `Maneki_${version}_x64-setup.exe`,
  );
  copyFileSync(bundle, join(destination, `Maneki_${version}_x64-setup.exe`));
  run([
    "--filter",
    "@maneki-pet/dsh-plugin",
    "pack",
    "--pack-destination",
    destination,
  ]);
  if (
    !existsSync(join(destination, `maneki-pet-dsh-plugin-${pluginVersion}.tgz`))
  )
    throw new Error("Missing dsh plugin archive");
  copyFileSync(
    join(root, "docs/install-windows.md"),
    join(destination, "INSTALL.zh-CN.md"),
  );
  mkdirSync(join(destination, "docs"), { recursive: true });
  copyFileSync(join(root, "docs/voice.md"), join(destination, "docs/voice.md"));
  copyFileSync(
    join(root, "docs/install-windows.md"),
    join(destination, "docs/install-windows.md"),
  );
  mkdirSync(join(destination, "docs/audits"));
  for (const name of [
    "2026-11-07-cloud-voice.md",
    "2026-11-07-push-to-talk-voice.md",
    "2026-11-08-windows-preview-delivery.md",
  ]) {
    copyFileSync(
      join(root, "docs/audits", name),
      join(destination, "docs/audits", name),
    );
  }
  copyFileSync(join(root, "LICENSE"), join(destination, "LICENSE.txt"));
  copyFileSync(
    join(root, "apps/desktop/src-tauri/installer/TAURI-LICENSE-MIT"),
    join(destination, "TAURI-LICENSE-MIT.txt"),
  );
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const diff = spawnSync("git", ["diff", "--quiet", "HEAD", "--"], {
    cwd: root,
    windowsHide: true,
  });
  if (diff.status !== 0 && diff.status !== 1)
    throw new Error("Cannot establish release source state");
  const dirty = diff.status === 1;
  const walk = (relative = "") =>
    readdirSync(join(destination, relative), { withFileTypes: true }).flatMap(
      (entry) =>
        entry.isDirectory()
          ? walk(join(relative, entry.name))
          : [join(relative, entry.name)],
    );
  const files = walk()
    .sort()
    .map((name) => ({
      name: name.replaceAll("\\", "/"),
      bytes: statSync(join(destination, name)).size,
      sha256: hash(join(destination, name)),
    }));
  writeFileSync(
    join(destination, "release.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        version,
        platform: "windows-x64",
        sourceCommit,
        dirty,
        pluginVersion,
        nodeVersion: process.version,
        files,
        manualAcceptance:
          "See INSTALL.zh-CN.md; no real cloud/device authorization performed",
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(destination, "SHA256SUMS.txt"),
    [
      ...files,
      { name: "release.json", sha256: hash(join(destination, "release.json")) },
    ]
      .map((f) => `${f.sha256}  ${f.name}`)
      .join("\n") + "\n",
  );
  console.log(`Preview delivery ready: ${destination}`);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
