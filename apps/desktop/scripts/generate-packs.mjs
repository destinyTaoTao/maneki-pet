import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePetPack } from "@maneki-pet/core";
import { installPack, verifyPackOnDisk } from "./lib/pack-fs.mjs";
import { assertPackNotRetired } from "./lib/pack-preparation.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--public-dir" || !args[1])) {
  throw new Error("Usage: node scripts/generate-packs.mjs [--public-dir <dir>]");
}
const publicRoot = args.length ? resolve(args[1]) : join(root, "public");
const scratch = mkdtempSync(join(tmpdir(), "maneki-placeholder-"));
const size = 128;
const frameCount = 2;
const framesPerSecond = 2;
// 旧内置招财猫 breathe/0 PNG 的冻结指纹；仅迁移这一份已知程序素材。
const retiredFallback = {
  bytes: 918,
  sha256: "a3572467bfe134438104aaec1585da25cbaa9ed5cc864cde7cfc7db4be0659ad",
};

const palettes = {
  default: [[226, 232, 240, 255], [148, 163, 184, 255], [71, 85, 105, 255]],
  mint: [[209, 250, 229, 255], [110, 231, 183, 255], [5, 150, 105, 255]],
};

function drawPlaceholder(frame, palette) {
  const buffer = new Uint8Array(size * size * 4);
  // 三个方块仅标识开发素材，不构成角色或沿用旧招财猫轮廓。
  for (let index = 0; index < 3; index += 1) {
    const x = 22 + index * 30;
    const y = 52 + (index === frame ? -4 : 0);
    for (let row = y; row < y + 24; row += 1) {
      for (let column = x; column < x + 24; column += 1) {
        buffer.set(palette[index], (row * size + column) * 4);
      }
    }
  }
  return buffer;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return result;
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, row + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function horizontalSprite(frames) {
  const result = new Uint8Array(size * size * 4 * frames.length);
  frames.forEach((frame, index) => {
    for (let y = 0; y < size; y += 1) {
      const sourceStart = y * size * 4;
      const targetStart = (y * size * frames.length + index * size) * 4;
      result.set(frame.subarray(sourceStart, sourceStart + size * 4), targetStart);
    }
  });
  return encodePng(size * frames.length, size, result);
}

function manifestEntry(path) {
  const bytes = readFileSync(path);
  const normalized = path.replaceAll("\\", "/");
  const assetsIndex = normalized.lastIndexOf("assets/");
  if (assetsIndex < 0) throw new Error(`Asset path is outside an assets directory: ${path}`);
  return {
    path: normalized.slice(assetsIndex),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

function writePack({ id, name, palette, clips, withVideo, fullStateSet }) {
  const target = join(publicRoot, "packs", id);
  if (existsSync(target)) {
    const packRoot = target;
    try {
      const pack = JSON.parse(readFileSync(join(packRoot, "pet-pack.json"), "utf8"));
      assertPackNotRetired(pack);
      const manifest = JSON.parse(readFileSync(join(packRoot, "assets.manifest.json"), "utf8"));
      const result = validatePetPack(pack, manifest);
      if (!result.success) throw new Error(JSON.stringify(result.errors));
      if (result.value.pack.id !== id) throw new Error(`Pack id must match directory ${id}`);
      const errors = verifyPackOnDisk(packRoot, result.value.pack, result.value.manifest);
      if (errors.length) throw new Error(errors.join("; "));
      console.log(`Kept validated local pack ${id}@${pack.version} (${pack.name})`);
      return true;
    } catch (error) {
      throw new Error(`Existing pack ${id} is invalid; preserved without overwrite. Repair or explicitly import a valid pack with install-pack.mjs: ${error.message}`);
    }
  }
  const packRoot = join(scratch, "packs", id);
  const assets = join(packRoot, "assets");
  mkdirSync(assets, { recursive: true });
  const definitions = {};
  const files = [];
  for (const clip of clips) {
    const frames = Array.from({ length: frameCount }, (_, frame) => drawPlaceholder(frame, palette));
    const pngPath = join(assets, `${clip}.png`);
    writeFileSync(pngPath, horizontalSprite(frames));
    const sources = [];
    if (withVideo) {
      const frameDir = join(scratch, id, clip);
      mkdirSync(frameDir, { recursive: true });
      frames.forEach((frame, index) => writeFileSync(join(frameDir, `${index}.png`), encodePng(size, size, frame)));
      const videoPath = join(assets, `${clip}.webm`);
      execFileSync("ffmpeg", [
        "-y", "-loglevel", "error", "-framerate", String(framesPerSecond),
        "-i", join(frameDir, "%d.png"), "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
        "-b:v", "0", "-crf", "34", "-auto-alt-ref", "0", videoPath,
      ]);
      sources.push({ renderer: "video-alpha", path: `assets/${clip}.webm`, mimeType: "video/webm" });
      files.push(manifestEntry(videoPath));
    }
    sources.push({
      renderer: "spritesheet",
      path: `assets/${clip}.png`,
      mimeType: "image/png",
      frameWidth: size,
      frameHeight: size,
      frameCount,
      framesPerSecond,
    });
    definitions[clip] = { sources };
    files.push(manifestEntry(pngPath));
  }
  const states = { idle: fullStateSet ? { clips: ["breathe", "look"], weights: [4, 1] } : { clips: ["breathe"], weights: [1] } };
  if (fullStateSet) {
    Object.assign(states, {
      thinking: { clips: ["thinking"], weights: [1] },
      working: { clips: ["working"], weights: [1] },
      waiting_input: { clips: ["waiting"], weights: [1] },
      celebrating: { clips: ["celebrating"], weights: [1] },
      error: { clips: ["error"], weights: [1] },
      sleeping: { clips: ["sleeping"], weights: [1] },
    });
  }
  const pack = {
    schemaVersion: 1,
    id,
    name,
    version: "1.0.1",
    permissions: [],
    clips: definitions,
    states,
    actions: [{ id: "wave", clips: ["wave"], priority: 1, interruptible: true }],
  };
  writeFileSync(join(packRoot, "pet-pack.json"), `${JSON.stringify(pack, null, 2)}\n`);
  writeFileSync(
    join(packRoot, "assets.manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, algorithm: "sha256", files }, null, 2)}\n`,
  );
  installPack({ sourceDir: packRoot, packsRoot: join(publicRoot, "packs") });
  console.log(`Created development placeholder ${id}; official catgirl assets are not prepared by this command.`);
}

try {
writePack({
  id: "xiaozhao-default",
  name: "开发 · 中性占位",
  palette: palettes.default,
  clips: ["breathe", "look", "thinking", "working", "waiting", "celebrating", "error", "sleeping", "wave"],
  withVideo: true,
  fullStateSet: true,
});
writePack({
  id: "mint-test",
  name: "薄荷 · 中性占位",
  palette: palettes.mint,
  clips: ["breathe", "wave"],
  withVideo: false,
  fullStateSet: false,
});
const fallbackPath = join(publicRoot, "fallback.png");
const fallback = existsSync(fallbackPath) ? readFileSync(fallbackPath) : undefined;
const isRetiredFallback = fallback?.length === retiredFallback.bytes
  && createHash("sha256").update(fallback).digest("hex") === retiredFallback.sha256;
if (fallback && !isRetiredFallback) {
  console.log("Kept prepared fallback.png");
} else {
  writeFileSync(fallbackPath, encodePng(size, size, drawPlaceholder(0, palettes.default)));
  console.log("Created neutral development fallback; prepare the matching fallback when promoting official assets.");
}
if (args.length === 0) {
  mkdirSync(join(root, "src-tauri", "icons"), { recursive: true });
  writeFileSync(join(root, "src-tauri", "icons", "icon-source.png"), readFileSync(join(publicRoot, "fallback.png")));
}
writeFileSync(
  join(publicRoot, "packs", "ASSET-LICENSE.txt"),
  "仅由 scripts/generate-packs.mjs 生成的程序占位素材采用 MIT 许可证。\n显式导入的正式或第三方动作包不受本声明授权，须查阅对应素材发行说明。\n",
);
} finally {
rmSync(scratch, { recursive: true, force: true });
}
