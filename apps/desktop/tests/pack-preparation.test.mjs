import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 冻结旧生成器的 128×128 fallback，仅用于迁移回归，不作为发布素材。
const retiredFallback = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAADXUlEQVR42u2dMU4DMRBFcx4QEl0OQMH5uA0VB0HcgIqWJmgLpAji9dge2+s/70vTRYk9/3m867WzpxNCCCGEEEIIIYQQQgghhBBCCCGEEEIIDdHHy9OF/gAA/YkMgErSlPoyPGmrJ06lH1MTt2ryFPpwmOT1SODz+fGycvtDmV+axM1cr5jRfgAoTKKn4S1A1LQdFSbxOpEjjc+BUNJu1AjArbhl0vfXe3WUwGBtI+52BGCLFsM9gACAyQCMACEHAwBMNn8UBLUg4LIQADkQAGCS+TMgsIKA08IAWCDAaXEAchDg9CDzZ0OQAgG3E8u4auYDAQAkIcD1G2v5kQAAgsSDHEXzgcAIwJYkZQCYCjKj/zdJquZTBTKj/28oGU8VMI7+FghWMJ8qYBz9e7GS2VSBDgAoRFgAMD84BAAAAAAAAHUAPNzd/4vRpnm2AQAAAAAAIBAArQc31AEICQEAMAUAAAAAAACwDgAAAAAAAAAEfePtfL4ZmA8AADBrMWgkBEcAIOyOoL2z9Mz9gcxPjYIRCff4HKO/AYC9ZEQEIKz5o6sAu4EPZn40CLz+hVQOgJFTwREBkAbBaqh6FUj1Tx6CEjNVIbD0SxaCUhOV1ghK+wIAQhDU9kEKghbjVoagte1SAHiv13vH1sYRv1MDEAB0MjwXswGQqQJHAuDa4M/XczJ6gVA7jQCAo/l7xqdAmAWARBU4AgA15veAAAAmArBX5nNTw2wAloWg9bat5+gvBcADgnAAtFaAXGKsn8td6FkuDq0LOL36CgAAAAAAAABFybbM6yUAWPYzAAAVAAAAAADcbgX3SvuRAOj5pJJbwYaR5rkOQAVYEIC9KlCyHNyjXaEA8EpOzXd5PAsAgIUBqIWgZhcPAHSEoPU7avYD9JyaAGAwANbDGS17GAGg8wbRmWsKM9oot0285SJulZ3AAGAAoOak0CrbwSn/ThCseCAEACog6HFBpjANhDg6rvh/QZ4AnCJJ7UAoo98BgqhVgPcJB64CvFA68FTA6+QFq0DNmscJ6UGQ6gOvkReFoGStA/PFrgcwPjAEFoMx3WnFkH8BBQLMB4R5IGB80IdIXNAFBQHjF4PAY6Mnt3FiIHgGWQ8IA9kNCANZFAeELCCEEEIIIYQQQgghhLT1A2C3JCcGo1sMAAAAAElFTkSuQmCC", "base64");

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
function writeApprovedPack(root, identity = {}) {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "assets", "approved.png"), bytes);
  writeFileSync(join(root, "pet-pack.json"), JSON.stringify({
    schemaVersion: 1, id: "xiaozhao-default", name: "已批准形象", version: "2.0.0", ...identity, permissions: [],
    clips: { idle: { sources: [{ renderer: "spritesheet", path: "assets/approved.png", mimeType: "image/png",
      frameWidth: 1, frameHeight: 1, frameCount: 1, framesPerSecond: 1 }] } },
    states: { idle: { clips: ["idle"], weights: [1] } }, actions: [],
  }));
  writeFileSync(join(root, "assets.manifest.json"), JSON.stringify({
    schemaVersion: 1, algorithm: "sha256", files: [{ path: "assets/approved.png", bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }],
  }));
}

it("prepares neutral development placeholders without writing application icons in an isolated public directory", () => {
  const publicDir = join(workspace(), "public");
  const icon = join(desktop, "src-tauri", "icons", "icon-source.png");
  const before = existsSync(icon) ? { bytes: readFileSync(icon), modified: statSync(icon).mtimeMs } : undefined;

  const result = cli("generate-packs.mjs", ["--public-dir", publicDir]);

  expect(result.status, result.stderr).toBe(0);
  for (const [id, name] of [["xiaozhao-default", "开发 · 中性占位"], ["mint-test", "薄荷 · 中性占位"]]) {
    const pack = JSON.parse(readFileSync(join(publicDir, "packs", id, "pet-pack.json"), "utf8"));
    expect(pack).toMatchObject({ schemaVersion: 1, id, name, version: "1.0.1" });
  }
  expect(createHash("sha256").update(readFileSync(join(publicDir, "fallback.png"))).digest("hex"))
    .not.toBe("a3572467bfe134438104aaec1585da25cbaa9ed5cc864cde7cfc7db4be0659ad");
  expect(existsSync(icon) ? { bytes: readFileSync(icon), modified: statSync(icon).mtimeMs } : undefined).toEqual(before);
  expect(readFileSync(join(publicDir, "packs", "ASSET-LICENSE.txt"), "utf8")).toBe(
    "仅由 scripts/generate-packs.mjs 生成的程序占位素材采用 MIT 许可证。\n显式导入的正式或第三方动作包不受本声明授权，须查阅对应素材发行说明。\n",
  );
}, 30_000);

it("rejects only the retired built-in default during preparation and preserves its files for explicit migration", () => {
  const root = workspace();
  const source = join(root, "retired");
  const publicDir = join(root, "public");
  const packs = join(publicDir, "packs");
  writeApprovedPack(source, { name: "小招 · 招财猫", version: "1.0.0" });
  expect(cli("install-pack.mjs", [source, "--packs-dir", packs]).status).toBe(0);
  const descriptor = readFileSync(join(packs, "xiaozhao-default", "pet-pack.json"));
  const media = readFileSync(join(packs, "xiaozhao-default", "assets", "approved.png"));

  for (const [script, args] of [
    ["generate-packs.mjs", ["--public-dir", publicDir]],
    ["validate-packs.mjs", ["--packs-dir", packs]],
  ]) {
    const result = cli(script, args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Retired built-in default");
    expect(result.stderr).toContain("preserved without overwrite");
    expect(result.stderr).toContain("install-pack.mjs");
  }
  expect(readFileSync(join(packs, "xiaozhao-default", "pet-pack.json"))).toEqual(descriptor);
  expect(readFileSync(join(packs, "xiaozhao-default", "assets", "approved.png"))).toEqual(media);
});

it.each([
  ["migrates the known retired fallback", true, true],
  ["preserves a prepared custom fallback", false, true],
  ["preserves a prepared fallback before the default exists", false, false],
  ["preserves a different fallback with the retired byte count", false, true, true],
])("%s using the frozen retired fingerprint", (_label, retired, installed, sameByteCount = false) => {
  const root = workspace();
  const source = join(root, "approved");
  const publicDir = join(root, "public");
  writeApprovedPack(source);
  mkdirSync(publicDir, { recursive: true });
  if (installed) expect(cli("install-pack.mjs", [source, "--packs-dir", join(publicDir, "packs")]).status).toBe(0);
  const customFallback = readFileSync(join(source, "assets", "approved.png"));
  const fallback = retired ? retiredFallback : sameByteCount
    ? Buffer.concat([customFallback, Buffer.alloc(retiredFallback.length - customFallback.length)])
    : customFallback;
  writeFileSync(join(publicDir, "fallback.png"), fallback);

  const result = cli("generate-packs.mjs", ["--public-dir", publicDir]);

  expect(result.status, result.stderr).toBe(0);
  const prepared = readFileSync(join(publicDir, "fallback.png"));
  if (retired) {
    expect(createHash("sha256").update(prepared).digest("hex"))
      .toBe("f68776cda6a3ac7b568e7b925751d80959c8b3d79f335e2dcfaa608117a28218");
  } else {
    expect(prepared).toEqual(fallback);
  }
}, 30_000);

it.each([
  ["custom", { name: "自定义形象", version: "1.0.0" }],
  ["later", { name: "小招 · 招财猫", version: "1.1.0" }],
])("keeps an explicitly installed %s default pack when preparing missing placeholders", (_label, identity) => {
  const root = workspace();
  const source = join(root, "approved");
  const publicDir = join(root, "public");
  const packs = join(publicDir, "packs");
  writeApprovedPack(source, identity);
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
  expect(cli("validate-packs.mjs", ["--packs-dir", packs]).status).toBe(0);
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
