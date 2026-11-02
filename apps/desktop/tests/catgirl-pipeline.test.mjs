import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = [];
afterEach(() => {
  for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
});
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "maneki-catgirl-"));
  workspaces.push(root);
  return root;
}
function cli(script, args) {
  return spawnSync(process.execPath, [join(desktop, "scripts", script), ...args], {
    cwd: desktop, encoding: "utf8", timeout: 90_000,
  });
}
function trialRecipe() {
  return {
    recipeVersion: 1, id: "xiaozhao-catgirl-trial", name: "小招 · 橘猫娘试片", version: "0.1.0",
    clips: { idle: { input: "source.mp4", loop: "ping-pong" },
      working: { input: "source.mp4", loop: "ping-pong" }, wave: { input: "source.mp4" } },
    states: { idle: { clips: ["idle"], weights: [1] }, working: { clips: ["working"], weights: [1] } },
    actions: [{ id: "wave", clips: ["wave"], priority: 1, interruptible: true }],
  };
}

it("builds silent transparent trial clips and budgeted horizontal fallback into an installable v1 pack", () => {
  const root = workspace();
  // 有声绿幕合成探针仅测试媒体管线，不冒充角色动画或视觉验收。
  const fixture = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i",
    "color=c=0x00ff00:s=64x64:r=24:d=5,drawbox=x=16:y=16:w=32:h=40:color=red:t=fill",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", "-movflags", "+faststart", join(root, "source.mp4")], { encoding: "utf8" });
  expect(fixture.status, fixture.stderr).toBe(0);
  const recipe = join(root, "recipe.json");
  writeFileSync(recipe, JSON.stringify(trialRecipe()));
  const packs = join(root, "packs");

  const built = cli("build-catgirl-pack.mjs", [recipe, "--packs-dir", packs]);

  expect(built.status, built.stderr).toBe(0);
  const packRoot = join(packs, "xiaozhao-catgirl-trial");
  const installed = cli("install-pack.mjs", [packRoot, "--packs-dir", join(root, "installed")]);
  expect(installed.status, installed.stderr).toBe(0);
  const pack = JSON.parse(readFileSync(join(packRoot, "pet-pack.json"), "utf8"));
  expect(Object.keys(pack.states)).toEqual(["idle", "working"]);
  expect(pack.actions.map((action) => action.id)).toEqual(["wave"]);
  const png = readFileSync(join(packRoot, "assets", "idle.png"));
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([15_360, 384]);
  const probe = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-of", "json",
    join(packRoot, "assets", "idle.webm")], { encoding: "utf8" });
  expect(probe.status, probe.stderr).toBe(0);
  const streams = JSON.parse(probe.stdout).streams;
  expect(streams).toHaveLength(1);
  expect([streams[0].width, streams[0].height, streams[0].nb_read_frames, streams[0].r_frame_rate])
    .toEqual([384, 384, "120", "24/1"]);
  const alpha = spawnSync("ffmpeg", ["-v", "error", "-c:v", "libvpx-vp9", "-i",
    join(packRoot, "assets", "idle.webm"), "-vf", "alphaextract", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"]);
  expect(alpha.status, alpha.stderr?.toString()).toBe(0);
  expect(alpha.stdout[0]).toBe(0);
  expect(alpha.stdout[192 * 384 + 192]).toBe(255);
  const report = JSON.parse(readFileSync(join(packs, "xiaozhao-catgirl-trial.build.json"), "utf8"));
  expect(report.inputs.idle.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(report.media.idle.frames).toBe(120);
  expect(existsSync(join(packs, "xiaozhao-default"))).toBe(false);

  // 原片交接不完整时再次运行仍保留上一版可安装候选，不能留下半包。
  const manifest = readFileSync(join(packRoot, "assets.manifest.json"));
  const missingSource = trialRecipe();
  missingSource.clips.working.input = "not-delivered.mp4";
  writeFileSync(recipe, JSON.stringify(missingSource));
  const failed = cli("build-catgirl-pack.mjs", [recipe, "--packs-dir", packs]);
  expect(failed.status).not.toBe(0);
  expect(failed.stderr).toContain("Missing source media");
  expect(readFileSync(join(packRoot, "assets.manifest.json"))).toEqual(manifest);
  expect(cli("install-pack.mjs", [packRoot, "--packs-dir", join(root, "recovered")]).status).toBe(0);

  // 损坏发生在循环选段之后，前 60 帧可读也不能冒充原片已完整解码。
  const sourceBytes = readFileSync(join(root, "source.mp4"));
  writeFileSync(join(root, "truncated.mp4"), sourceBytes.subarray(0, sourceBytes.length - 800));
  const corruptSource = trialRecipe();
  corruptSource.clips.idle.input = "truncated.mp4";
  writeFileSync(recipe, JSON.stringify(corruptSource));
  const corrupted = cli("build-catgirl-pack.mjs", [recipe, "--packs-dir", packs]);
  expect(corrupted.status).not.toBe(0);
  expect(readFileSync(join(packRoot, "assets.manifest.json"))).toEqual(manifest);
}, 90_000);

it("rejects an incomplete trial recipe using the reserved default identity before writing output", () => {
  const root = workspace();
  const recipe = trialRecipe();
  recipe.id = "xiaozhao-default";
  const recipePath = join(root, "recipe.json");
  writeFileSync(recipePath, JSON.stringify(recipe));
  const packs = join(root, "packs");

  const result = cli("build-catgirl-pack.mjs", [recipePath, "--packs-dir", packs]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("reserved");
  expect(existsSync(packs)).toBe(false);
});
