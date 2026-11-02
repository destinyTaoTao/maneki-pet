import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = [];
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "maneki-prepare-"));
  workspaces.push(root);
  return root;
}
afterEach(() => {
  for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
});
function cli(script, args, env = process.env) {
  return spawnSync(process.execPath, [join(desktop, "scripts", script), ...args], {
    cwd: desktop, encoding: "utf8", timeout: 60_000, env,
  });
}
function writeApprovedPack(root) {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "assets", "approved.png"), bytes);
  writeFileSync(join(root, "pet-pack.json"), JSON.stringify({
    schemaVersion: 1, id: "xiaozhao-default", name: "已批准形象", version: "2.0.0", permissions: [],
    clips: { idle: { sources: [{ renderer: "spritesheet", path: "assets/approved.png", mimeType: "image/png",
      frameWidth: 1, frameHeight: 1, frameCount: 1, framesPerSecond: 1 }] } },
    states: { idle: { clips: ["idle"], weights: [1] } }, actions: [],
  }));
  writeFileSync(join(root, "assets.manifest.json"), JSON.stringify({
    schemaVersion: 1, algorithm: "sha256", files: [{ path: "assets/approved.png", bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }],
  }));
}

it("keeps an explicitly installed default pack when preparing missing placeholders", () => {
  const root = workspace();
  const source = join(root, "approved");
  const publicDir = join(root, "public");
  const packs = join(publicDir, "packs");
  writeApprovedPack(source);
  expect(cli("install-pack.mjs", [source, "--packs-dir", packs]).status).toBe(0);
  const before = readFileSync(join(packs, "xiaozhao-default", "pet-pack.json"));
  const fallback = readFileSync(join(source, "assets", "approved.png"));
  writeFileSync(join(publicDir, "fallback.png"), fallback);

  const result = cli("generate-packs.mjs", ["--public-dir", publicDir]);

  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(publicDir, "fallback.png"))).toEqual(fallback);
  expect(existsSync(join(packs, "mint-test", "pet-pack.json"))).toBe(true);
  expect(readFileSync(join(packs, "xiaozhao-default", "pet-pack.json"))).toEqual(before);
  expect(readFileSync(join(packs, "xiaozhao-default", "assets", "approved.png")))
    .toEqual(readFileSync(join(source, "assets", "approved.png")));
}, 30_000);

it("reports missing prepared assets with an explicit import step and creates no placeholder", () => {
  const packs = join(workspace(), "missing-packs");
  const result = cli("validate-packs.mjs", ["--packs-dir", packs]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Missing prepared pack xiaozhao-default");
  expect(result.stderr).toContain("install-pack.mjs");
  expect(existsSync(packs)).toBe(false);
});

it("reports a corrupted installed default without replacing it with the placeholder", () => {
  const root = workspace();
  const publicDir = join(root, "public");
  const installed = join(publicDir, "packs", "xiaozhao-default");
  writeApprovedPack(installed);
  const damaged = Buffer.from("corrupt media, original manifest retained");
  writeFileSync(join(installed, "assets", "approved.png"), damaged);
  const descriptor = readFileSync(join(installed, "pet-pack.json"));

  const result = cli("generate-packs.mjs", ["--public-dir", publicDir]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Integrity mismatch");
  expect(result.stderr).toContain("preserved without overwrite");
  expect(readFileSync(join(installed, "assets", "approved.png"))).toEqual(damaged);
  expect(readFileSync(join(installed, "pet-pack.json"))).toEqual(descriptor);
});


it("can prepare missing placeholders after a first run without FFmpeg", () => {
  const root = workspace();
  const publicDir = join(root, "public");
  const packs = join(publicDir, "packs");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  env.PATH = root;

  const failed = cli("generate-packs.mjs", ["--public-dir", publicDir], env);

  expect(failed.status).not.toBe(0);
  expect(failed.stderr).toContain("ffmpeg");
  expect(existsSync(join(packs, "xiaozhao-default"))).toBe(false);
  const recovered = cli("generate-packs.mjs", ["--public-dir", publicDir]);
  expect(recovered.status, recovered.stderr).toBe(0);
  expect(cli("install-pack.mjs", [join(packs, "xiaozhao-default"), "--packs-dir", join(root, "installed")]).status).toBe(0);
}, 30_000);
