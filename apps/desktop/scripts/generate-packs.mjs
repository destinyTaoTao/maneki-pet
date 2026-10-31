import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = join(root, "public");
const scratch = join(root, "..", "..", "scratch", "pack-generation");
const size = 128;
const frameCount = 2;
const framesPerSecond = 2;

const palettes = {
  default: { body: [250, 241, 218, 255], patch: [220, 145, 67, 255], accent: [190, 55, 55, 255] },
  mint: { body: [213, 242, 230, 255], patch: [67, 155, 139, 255], accent: [48, 104, 115, 255] },
};
const outline = [71, 55, 48, 255];
const dark = [45, 42, 43, 255];
const gold = [235, 184, 55, 255];

function pixels() {
  return new Uint8Array(size * size * 4);
}

function setPixel(buffer, x, y, color) {
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  const offset = (Math.round(y) * size + Math.round(x)) * 4;
  buffer.set(color, offset);
}

function rectangle(buffer, x, y, width, height, color) {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      setPixel(buffer, column, row, color);
    }
  }
}

function ellipse(buffer, cx, cy, rx, ry, fill, border = outline) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
      const distance = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (distance <= 1) setPixel(buffer, x, y, distance > 0.79 ? border : fill);
    }
  }
}

function triangle(buffer, ax, ay, bx, by, cx, cy, color) {
  const minX = Math.floor(Math.min(ax, bx, cx));
  const maxX = Math.ceil(Math.max(ax, bx, cx));
  const minY = Math.floor(Math.min(ay, by, cy));
  const maxY = Math.ceil(Math.max(ay, by, cy));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
      const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
      const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
      if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) {
        setPixel(buffer, x, y, color);
      }
    }
  }
}

function drawCat(mode, frame, palette) {
  const buffer = pixels();
  const bob = frame === 0 ? 0 : 1;
  const sleepy = mode === "sleeping";
  const error = mode === "error";
  const pawRaised = ["wave", "celebrating", "working"].includes(mode) || frame === 1;
  const bodyY = 88 + bob;

  triangle(buffer, 34, 46 + bob, 39, 18 + bob, 57, 39 + bob, palette.patch);
  triangle(buffer, 72, 39 + bob, 91, 18 + bob, 96, 47 + bob, palette.patch);
  ellipse(buffer, 64, bodyY, 32, 29, palette.body);
  ellipse(buffer, 34, 79 + bob, 12, 20, palette.body);
  ellipse(buffer, 93, pawRaised ? 64 + bob : 86 + bob, 12, 21, palette.body);
  ellipse(buffer, 64, 52 + bob, 36, 29, palette.body);
  ellipse(buffer, 46, 35 + bob, 11, 9, palette.patch, palette.patch);
  rectangle(buffer, 38, 73 + bob, 52, 7, palette.accent);
  ellipse(buffer, 64, 83 + bob, 10, 10, gold);
  rectangle(buffer, 61, 78 + bob, 6, 10, outline);

  if (sleepy) {
    rectangle(buffer, 43, 52 + bob, 10, 2, dark);
    rectangle(buffer, 76, 52 + bob, 10, 2, dark);
    rectangle(buffer, 100, 24, 12, 3, palette.accent);
    rectangle(buffer, 100, 24, 3, 11, palette.accent);
    rectangle(buffer, 101, 34, 12, 3, palette.accent);
  } else if (error) {
    for (const x of [44, 77]) {
      rectangle(buffer, x, 47 + bob, 3, 3, dark);
      rectangle(buffer, x + 6, 47 + bob, 3, 3, dark);
      rectangle(buffer, x + 3, 50 + bob, 3, 3, dark);
      rectangle(buffer, x, 53 + bob, 3, 3, dark);
      rectangle(buffer, x + 6, 53 + bob, 3, 3, dark);
    }
  } else {
    const lookOffset = mode === "look" || mode === "thinking" ? 2 : 0;
    rectangle(buffer, 44 + lookOffset, 49 + bob, 5, 7, dark);
    rectangle(buffer, 77 + lookOffset, 49 + bob, 5, 7, dark);
  }
  rectangle(buffer, 61, 59 + bob, 6, 3, palette.accent);
  rectangle(buffer, 58, 63 + bob, 3, 2, outline);
  rectangle(buffer, 68, 63 + bob, 3, 2, outline);

  if (mode === "thinking") {
    ellipse(buffer, 103, 29, 4, 4, palette.body);
    ellipse(buffer, 112, 17, 6, 6, palette.body);
  }
  if (mode === "celebrating") {
    for (const [x, y, color] of [
      [17, 24, gold],
      [109, 39, palette.accent],
      [23, 52, palette.patch],
      [100, 12, gold],
    ]) {
      rectangle(buffer, x + frame * 2, y, 4, 7, color);
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
  const packRoot = join(publicRoot, "packs", id);
  const assets = join(packRoot, "assets");
  mkdirSync(assets, { recursive: true });
  const definitions = {};
  const files = [];
  for (const clip of clips) {
    const frames = Array.from({ length: frameCount }, (_, frame) => drawCat(clip, frame, palette));
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
    version: "1.0.0",
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
}

rmSync(scratch, { recursive: true, force: true });
writePack({
  id: "xiaozhao-default",
  name: "小招 · 招财猫",
  palette: palettes.default,
  clips: ["breathe", "look", "thinking", "working", "waiting", "celebrating", "error", "sleeping", "wave"],
  withVideo: true,
  fullStateSet: true,
});
writePack({
  id: "mint-test",
  name: "薄荷 · 测试形象",
  palette: palettes.mint,
  clips: ["breathe", "wave"],
  withVideo: false,
  fullStateSet: false,
});
writeFileSync(join(publicRoot, "fallback.png"), encodePng(size, size, drawCat("breathe", 0, palettes.default)));
mkdirSync(join(root, "src-tauri", "icons"), { recursive: true });
writeFileSync(join(root, "src-tauri", "icons", "icon-source.png"), encodePng(size, size, drawCat("wave", 1, palettes.default)));
writeFileSync(
  join(publicRoot, "packs", "ASSET-LICENSE.txt"),
  "本目录素材由 scripts/generate-packs.mjs 程序生成，当前仅作 M1 默认与测试形象。\n这些原创占位素材与本项目代码采用相同 MIT 许可证；最终官方形象授权另行发布。\n",
);
rmSync(scratch, { recursive: true, force: true });
