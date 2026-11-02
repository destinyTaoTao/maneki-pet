// 橘猫娘离线素材入口：原片 → 静音透明视频/横排精灵图 → 既有 v1 安装器。
// 配方只处理媒体；不启动生成模型，也不替代创作与桌面验收。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validatePetPack } from "@maneki-pet/core";
import { installPack } from "./lib/pack-fs.mjs";

const size = 384;
const frames = 120;
const fps = 24;
const spriteSize = 256;
const spriteFrames = 40;
const spriteFps = 8;
const commands = [];

function run(tool, args, binary = false) {
  commands.push({ tool, args });
  try {
    return execFileSync(tool, args, { encoding: binary ? undefined : "utf8", timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`${tool} failed (requires local FFmpeg with libvpx-vp9): ${error.stderr?.toString() || error.message}`);
  }
}
function probe(path) {
  return JSON.parse(run("ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", path]));
}
function fields(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label}: unknown fields ${unknown.join(", ")}`);
}
function checkRecipe(recipe) {
  fields(recipe, ["recipeVersion", "id", "name", "version", "clips", "states", "actions", "chromaKey"], "recipe");
  if (recipe.recipeVersion !== 1) throw new Error("recipeVersion must be 1");
  if (recipe.id === "xiaozhao-default") throw new Error("xiaozhao-default is reserved; build a separate trial/candidate pack before manual acceptance and promotion");
  fields(recipe.clips, Object.keys(recipe.clips ?? {}), "clips");
  for (const [id, clip] of Object.entries(recipe.clips)) {
    fields(clip, ["input", "startSeconds", "crop", "loop"], `clips.${id}`);
    if (typeof clip.input !== "string" || !clip.input.trim()) throw new Error(`${id}: input must be a local file path`);
    if (!Number.isFinite(clip.startSeconds ?? 0) || (clip.startSeconds ?? 0) < 0) throw new Error(`${id}: startSeconds must be nonnegative`);
    if (!["forward", "ping-pong"].includes(clip.loop ?? "forward")) throw new Error(`${id}: unsupported loop`);
    if (clip.crop !== undefined) {
      fields(clip.crop, ["x", "y", "width", "height"], `${id}.crop`);
      if (![clip.crop.x, clip.crop.y].every((n) => Number.isInteger(n) && n >= 0)
        || ![clip.crop.width, clip.crop.height].every((n) => Number.isInteger(n) && n > 0)) throw new Error(`${id}: invalid crop rectangle`);
    }
  }
  const key = { color: "0x00ff00", similarity: 0.15, blend: 0.05, ...recipe.chromaKey };
  if (recipe.chromaKey !== undefined) fields(recipe.chromaKey, ["color", "similarity", "blend"], "chromaKey");
  if (!/^0x[0-9a-f]{6}$/i.test(key.color) || !Number.isFinite(key.similarity) || key.similarity < 0.00001
    || key.similarity > 1 || !Number.isFinite(key.blend) || key.blend < 0 || key.blend > 1) throw new Error("Invalid chromaKey parameters");
  return key;
}
function packFor(recipe) {
  return {
    schemaVersion: 1, id: recipe.id, name: recipe.name, version: recipe.version, permissions: [],
    clips: Object.fromEntries(Object.keys(recipe.clips).map((id) => [id, { sources: [
      { renderer: "video-alpha", path: `assets/${id}.webm`, mimeType: "video/webm" },
      { renderer: "spritesheet", path: `assets/${id}.png`, mimeType: "image/png", frameWidth: spriteSize,
        frameHeight: spriteSize, frameCount: spriteFrames, framesPerSecond: spriteFps },
    ] }])),
    states: recipe.states, actions: recipe.actions,
  };
}
function checkPack(pack, files) {
  const result = validatePetPack(pack, { schemaVersion: 1, algorithm: "sha256", files });
  if (!result.success) throw new Error(`Invalid v1 pack mapping: ${JSON.stringify(result.errors)}`);
}
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function filterFor(clip, key) {
  const count = clip.loop === "ping-pong" ? 60 : frames;
  const trim = `[0:v:0]fps=${fps},trim=end_frame=${count},setpts=PTS-STARTPTS`;
  const loop = clip.loop === "ping-pong"
    ? `${trim},split[forward][reverse];[reverse]reverse[back];[forward][back]concat=n=2:v=1:a=0,setpts=N/${fps}/TB`
    : trim;
  const crop = clip.crop ? `crop=${clip.crop.width}:${clip.crop.height}:${clip.crop.x}:${clip.crop.y}:exact=1,` : "";
  return `${loop},${crop}chromakey=${key.color}:${key.similarity}:${key.blend},despill=green,scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=lanczos,format=yuva420p,pad=${size}:${size}:(ow-iw)/2:oh-ih:color=black@0,setsar=1[out]`;
}
function verifyMedia(video, png) {
  const info = probe(video);
  const stream = info.streams.find((item) => item.codec_type === "video");
  const duration = Number(info.format.duration);
  if (info.streams.length !== 1 || stream?.codec_name !== "vp9" || stream.width !== size || stream.height !== size
    || stream.nb_read_frames !== String(frames) || stream.r_frame_rate !== "24/1" || Math.abs(duration - 5) > 0.05) {
    throw new Error(`Unexpected video dimensions/frames/duration or audio stream: ${video}`);
  }
  // 原生 VP9 解码器可能忽略 alpha；显式选择 libvpx，实际解出 alpha 平面并完整解码。
  const alpha = run("ffmpeg", ["-v", "error", "-c:v", "libvpx-vp9", "-i", video, "-vf", "alphaextract",
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], true);
  if (alpha.length !== size * size || !alpha.some((value) => value < 255) || !alpha.some((value) => value > 0)) {
    throw new Error(`Missing transparent or visible pixels: ${video}`);
  }
  run("ffmpeg", ["-v", "error", "-xerror", "-c:v", "libvpx-vp9", "-i", video, "-f", "null", "-"]);
  const image = probe(png).streams;
  if (image.length !== 1 || image[0].width !== spriteSize * spriteFrames || image[0].height !== spriteSize) throw new Error(`Unexpected horizontal sprite dimensions: ${png}`);
  run("ffmpeg", ["-v", "error", "-xerror", "-i", png, "-f", "null", "-"]);
  let alphaMin = 255;
  let alphaMax = 0;
  for (const value of alpha) { alphaMin = Math.min(alphaMin, value); alphaMax = Math.max(alphaMax, value); }
  return { width: size, height: size, frames, fps, duration, audio: false, alphaMin, alphaMax, alphaScope: "first frame; full video separately decoded",
    spriteWidth: spriteSize * spriteFrames, spriteHeight: spriteSize, spriteFrames, spriteFps };
}

// 制作记录不是包内素材，但须和候选一起成功；先准备完整副本，再保留旧两者用于回滚。
function publishCandidate(sourceDir, packsRoot, id, report) {
  mkdirSync(packsRoot, { recursive: true });
  const record = join(packsRoot, `${id}.build.json`);
  if (existsSync(record) && !lstatSync(record).isFile()) throw new Error(`Build record is not a regular file: ${record}`);
  const prepared = mkdtempSync(join(packsRoot, ".catgirl-publish-"));
  const moved = [];
  const published = [];
  let cleanup = true;
  try {
    installPack({ sourceDir, packsRoot: prepared });
    writeFileSync(join(prepared, `${id}.build.json`), `${JSON.stringify(report, null, 2)}\n`);
    for (const [index, name] of [id, `${id}.build.json`].entries()) {
      const target = join(packsRoot, name);
      if (existsSync(target)) {
        const backup = join(prepared, `.previous-${index}`);
        renameSync(target, backup);
        moved.push({ target, backup });
      }
      renameSync(join(prepared, name), target);
      published.push(target);
    }
  } catch (error) {
    try {
      for (const target of published.reverse()) rmSync(target, { recursive: true, force: true });
      for (const { target, backup } of moved.reverse()) renameSync(backup, target);
    } catch (rollbackError) {
      cleanup = false;
      throw new Error(`${error.message}; rollback failed: ${rollbackError.message}; originals retained in ${prepared}`);
    }
    throw error;
  } finally {
    if (cleanup) {
      try { rmSync(prepared, { recursive: true, force: true }); }
      catch (error) { console.warn(`Could not remove publication backup ${prepared}: ${error.message}`); }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[1] !== "--packs-dir" || !args[0] || !args[2]) {
    throw new Error("Usage: node scripts/build-catgirl-pack.mjs <recipe.json> --packs-dir <output-dir>");
  }
  const recipePath = resolve(args[0]);
  const recipe = JSON.parse(readFileSync(recipePath, "utf8"));
  const key = checkRecipe(recipe);
  const pack = packFor(recipe);
  const paths = Object.values(pack.clips).flatMap((clip) => clip.sources.map((source) => source.path));
  // 在启动外部工具前复用正式契约检查映射与预算，不另造一套包规则。
  checkPack(pack, paths.map((path) => ({ path, bytes: 1, sha256: "0".repeat(64) })));
  if (recipe.id === "xiaozhao-catgirl-trial" && (Object.keys(recipe.states).sort().join(",") !== "idle,working"
    || recipe.actions.length !== 1 || recipe.actions[0].id !== "wave")) throw new Error("Trial pack only declares idle/working and wave");
  const packsRoot = resolve(args[2]);
  const scratch = mkdtempSync(join(tmpdir(), "maneki-catgirl-build-"));
  try {
    mkdirSync(join(scratch, "assets"));
    const report = { recipe, inputs: {}, media: {}, ffmpegVersion: run("ffmpeg", ["-version"]).split(/\r?\n/)[0], commands };
    const files = [];
    for (const [id, clip] of Object.entries(recipe.clips)) {
      const source = resolve(dirname(recipePath), clip.input);
      let stats;
      try { stats = statSync(source); } catch { throw new Error(`${id}: Missing source media ${source}; obtain the recorded original before building`); }
      if (!stats.isFile()) throw new Error(`${id}: source is not a file`);
      const sourceInfo = probe(source);
      const sourceVideo = sourceInfo.streams.find((item) => item.codec_type === "video");
      const requiredDuration = (clip.startSeconds ?? 0) + (clip.loop === "ping-pong" ? 2.5 : 5);
      if (!sourceVideo || Number(sourceInfo.format.duration) + 0.001 < requiredDuration) throw new Error(`${id}: source video is too short; need ${requiredDuration} seconds`);
      if (clip.crop && (clip.crop.x + clip.crop.width > sourceVideo.width || clip.crop.y + clip.crop.height > sourceVideo.height)) throw new Error(`${id}: crop is outside source frame`);
      report.inputs[id] = { path: source, sha256: await digest(source), bytes: stats.size, width: sourceVideo.width, height: sourceVideo.height };
      run("ffmpeg", ["-v", "error", "-xerror", "-i", source, "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"]);
      report.inputs[id].fullDecode = true;
      const video = join(scratch, "assets", `${id}.webm`);
      const png = join(scratch, "assets", `${id}.png`);
      run("ffmpeg", ["-y", "-v", "error", "-ss", String(clip.startSeconds ?? 0), "-i", source,
        "-filter_complex", filterFor(clip, key), "-map", "[out]", "-an", "-frames:v", String(frames), "-r", String(fps),
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "28", "-auto-alt-ref", "0", video]);
      run("ffmpeg", ["-y", "-v", "error", "-c:v", "libvpx-vp9", "-i", video, "-an", "-vf",
        `fps=${spriteFps},scale=${spriteSize}:${spriteSize}:flags=lanczos,format=rgba,tile=${spriteFrames}x1`, "-frames:v", "1", png]);
      report.media[id] = verifyMedia(video, png);
      for (const extension of ["webm", "png"]) {
        const path = `assets/${id}.${extension}`;
        const absolute = join(scratch, path);
        files.push({ path, sha256: await digest(absolute), bytes: statSync(absolute).size });
      }
    }
    checkPack(pack, files);
    writeFileSync(join(scratch, "pet-pack.json"), `${JSON.stringify(pack, null, 2)}\n`);
    writeFileSync(join(scratch, "assets.manifest.json"), `${JSON.stringify({ schemaVersion: 1, algorithm: "sha256", files }, null, 2)}\n`);
    report.outputs = files;
    publishCandidate(scratch, packsRoot, recipe.id, report);
    console.log(`Built candidate ${recipe.id}@${recipe.version} -> ${join(packsRoot, recipe.id)}; visual and desktop acceptance remain required.`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
try { await main(); } catch (error) {
  console.error(`Catgirl build failed: ${error.message}`);
  process.exitCode = 1;
}
