// 动作包安装器行为测试：覆盖成功安装、原子替换、损坏/逃逸拒绝与旧包保留。
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installPack, verifyPackOnDisk } from "../scripts/lib/pack-fs.mjs";

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
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

function onePixelPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.from([0, 255, 255, 255, 255]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const SPRITE_BYTES = onePixelPng();

function fixturePack({ spriteBytes = SPRITE_BYTES } = {}) {
  const spriteEntry = {
    path: "assets/sprite.png",
    sha256: createHash("sha256").update(spriteBytes).digest("hex"),
    bytes: spriteBytes.length,
  };
  return {
    pack: {
      schemaVersion: 1,
      id: "fixture-pack",
      name: "测试包",
      version: "1.0.0",
      permissions: [],
      clips: {
        breathe: {
          sources: [
            {
              renderer: "spritesheet",
              path: "assets/sprite.png",
              mimeType: "image/png",
              frameWidth: 1,
              frameHeight: 1,
              frameCount: 1,
              framesPerSecond: 1,
            },
          ],
        },
      },
      states: { idle: { clips: ["breathe"], weights: [1] } },
      actions: [],
    },
    manifest: { schemaVersion: 1, algorithm: "sha256", files: [spriteEntry] },
    spriteBytes,
  };
}

function writeFixture(root, fixture) {
  const assets = join(root, "assets");
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(root, "pet-pack.json"), JSON.stringify(fixture.pack));
  writeFileSync(join(root, "assets.manifest.json"), JSON.stringify(fixture.manifest));
  writeFileSync(join(assets, "sprite.png"), fixture.spriteBytes);
}

function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), "maneki-install-"));
}

function leftoverTempDirs(packsRoot) {
  if (!existsSync(packsRoot)) return [];
  return readdirSync(packsRoot).filter(
    (name) => name.startsWith(".staging-") || name.startsWith(".backup-"),
  );
}

describe("installPack", () => {
  it("accepts a real QuickTime container carrying the qt brand", () => {
    const workspace = makeWorkspace();
    try {
      const source = join(workspace, "source");
      const movie = join(workspace, "movie.mov");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=16x16:d=0.1", "-c:v", "qtrle", "-f", "mov", movie], { windowsHide: true });
      const fixture = fixturePack({ spriteBytes: readFileSync(movie) });
      fixture.pack.clips.breathe.sources = [{ renderer: "video-alpha", path: "assets/sprite.png", mimeType: "video/quicktime" }];
      writeFixture(source, fixture);
      expect(installPack({ sourceDir: source, packsRoot: join(workspace, "packs") })).toEqual({ id: "fixture-pack", version: "1.0.0" });
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
  it.each([["mp4", "mpeg4", "video/quicktime"], ["matroska", "libvpx-vp9", "video/webm"]])("rejects %s masquerading as an allowed video container", (format, codec, mimeType) => {
    const workspace = makeWorkspace();
    try {
      const source = join(workspace, "source");
      const path = join(workspace, "video");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=16x16:d=0.1", "-c:v", codec, "-f", format, path], { windowsHide: true });
      const fixture = fixturePack({ spriteBytes: readFileSync(path) });
      fixture.pack.clips.breathe.sources = [{ renderer: "video-alpha", path: "assets/sprite.png", mimeType }];
      writeFixture(source, fixture);
      expect(() => installPack({ sourceDir: source, packsRoot: join(workspace, "packs") })).toThrow(/media/i);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
  it.each(["wrong MIME", "wrong strip dimensions", "corrupt pixels"])("rejects %s with matching manifest hashes", (kind) => {
    const workspace = makeWorkspace();
    try {
      const source = join(workspace, "source");
      const fixture = fixturePack();
      if (kind === "wrong MIME") fixture.pack.clips.breathe.sources[0].mimeType = "image/webp";
      if (kind === "wrong strip dimensions") fixture.pack.clips.breathe.sources[0].frameCount = 2;
      if (kind === "corrupt pixels") {
        fixture.spriteBytes = Buffer.from(SPRITE_BYTES);
        fixture.spriteBytes[45] ^= 255;
        fixture.manifest.files[0].sha256 = createHash("sha256").update(fixture.spriteBytes).digest("hex");
      }
      writeFixture(source, fixture);
      expect(() => installPack({ sourceDir: source, packsRoot: join(workspace, "packs") })).toThrow(/media/i);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
  it("rejects oversized but valid JSON before parsing or installing", () => {
    const workspace = makeWorkspace();
    try {
      const source = join(workspace, "source");
      const fixture = fixturePack();
      writeFixture(source, fixture);
      writeFileSync(join(source, "pet-pack.json"), " ".repeat(1024 * 1024) + JSON.stringify(fixture.pack));
      expect(() => installPack({ sourceDir: source, packsRoot: join(workspace, "packs") })).toThrow(/JSON.*(limit|size)/i);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
  it("rejects actual oversized assets before loading or decoding them", () => {
    const workspace = makeWorkspace();
    try {
      const source = join(workspace, "source");
      writeFixture(source, fixturePack());
      truncateSync(join(source, "assets/sprite.png"), 64 * 1024 * 1024 + 1);
      expect(() => installPack({ sourceDir: source, packsRoot: join(workspace, "packs") })).toThrow(/byte size|byte limit/i);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
  it("rejects fake media with a correct manifest and keeps the installed pack", () => {
    const workspace = makeWorkspace();
    try {
      const source = join(workspace, "source");
      const packsRoot = join(workspace, "packs");
      writeFixture(source, fixturePack());
      installPack({ sourceDir: source, packsRoot });
      const fake = fixturePack({ spriteBytes: Buffer.from("not an image, but hash and length are correct") });
      fake.pack.version = "2.0.0";
      writeFixture(source, fake);
      expect(() => installPack({ sourceDir: source, packsRoot })).toThrow(/media/i);
      expect(JSON.parse(readFileSync(join(packsRoot, "fixture-pack/pet-pack.json"), "utf8")).version).toBe("1.0.0");
      expect(leftoverTempDirs(packsRoot)).toEqual([]);
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  });
  it("installs a valid pack into the packs root", () => {
    const workspace = makeWorkspace();
    try {
      const source = join(workspace, "source");
      const packsRoot = join(workspace, "packs");
      writeFixture(source, fixturePack());

      const result = installPack({ sourceDir: source, packsRoot });

      expect(result).toEqual({ id: "fixture-pack", version: "1.0.0" });
      expect(existsSync(join(packsRoot, "fixture-pack", "pet-pack.json"))).toBe(true);
      expect(existsSync(join(packsRoot, "fixture-pack", "assets", "sprite.png"))).toBe(true);
      expect(leftoverTempDirs(packsRoot)).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("replaces an existing pack and leaves no staging or backup directories", () => {
    const workspace = makeWorkspace();
    try {
      const source = join(workspace, "source");
      const packsRoot = join(workspace, "packs");
      writeFixture(source, fixturePack());
      installPack({ sourceDir: source, packsRoot });

      const updated = fixturePack();
      updated.pack.version = "1.1.0";
      writeFixture(source, updated);
      const result = installPack({ sourceDir: source, packsRoot });

      expect(result.version).toBe("1.1.0");
      const installed = JSON.parse(readFileSync(join(packsRoot, "fixture-pack", "pet-pack.json"), "utf8"));
      expect(installed.version).toBe("1.1.0");
      expect(leftoverTempDirs(packsRoot)).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("keeps the old pack when the new source is corrupted", () => {
    const workspace = makeWorkspace();
    try {
      const source = join(workspace, "source");
      const packsRoot = join(workspace, "packs");
      writeFixture(source, fixturePack());
      installPack({ sourceDir: source, packsRoot });

      writeFixture(source, fixturePack());
      // 清单记录的是原始素材哈希，写入后篡改文件内容模拟真实损坏。
      writeFileSync(join(source, "assets", "sprite.png"), Buffer.from("not a png"));

      expect(() => installPack({ sourceDir: source, packsRoot })).toThrow(/Integrity mismatch/);
      const installed = JSON.parse(readFileSync(join(packsRoot, "fixture-pack", "pet-pack.json"), "utf8"));
      expect(installed.version).toBe("1.0.0");
      expect(leftoverTempDirs(packsRoot)).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a pack whose schemaVersion is unsupported", () => {
    const workspace = makeWorkspace();
    try {
      const source = join(workspace, "source");
      const packsRoot = join(workspace, "packs");
      const candidate = fixturePack();
      candidate.pack.schemaVersion = 2;
      writeFixture(source, candidate);

      expect(() => installPack({ sourceDir: source, packsRoot })).toThrow(/failed validation/);
      expect(existsSync(join(packsRoot, "fixture-pack"))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a manifest entry with a traversal path", () => {
    const workspace = makeWorkspace();
    try {
      const source = join(workspace, "source");
      const packsRoot = join(workspace, "packs");
      writeFileSync(join(workspace, "escape.png"), SPRITE_BYTES);
      const candidate = fixturePack();
      candidate.pack.clips.breathe.sources[0].path = "../escape.png";
      candidate.manifest.files[0].path = "../escape.png";
      writeFixture(source, candidate);

      expect(() => installPack({ sourceDir: source, packsRoot })).toThrow(
        /failed (validation|on-disk verification)/,
      );
      expect(existsSync(join(packsRoot, "fixture-pack"))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects symlinked asset files", () => {
    const workspace = makeWorkspace();
    try {
      const source = join(workspace, "source");
      const packsRoot = join(workspace, "packs");
      const outside = join(workspace, "outside.png");
      writeFileSync(outside, SPRITE_BYTES);
      const candidate = fixturePack();
      candidate.pack.clips.breathe.sources[0].path = "assets/link.png";
      candidate.manifest.files[0].path = "assets/link.png";
      writeFixture(source, candidate);
      rmSync(join(source, "assets", "sprite.png"), { force: true });
      // Windows 未开启开发者模式时文件符号链接需要管理员权限，失败则跳过本用例。
      try {
        symlinkSync(outside, join(source, "assets", "link.png"), "file");
      } catch {
        return;
      }

      expect(() => installPack({ sourceDir: source, packsRoot })).toThrow(/symbolic link/);
      expect(existsSync(join(packsRoot, "fixture-pack"))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("flags an asset file that is not listed in the manifest", () => {
    const workspace = makeWorkspace();
    try {
      const source = join(workspace, "source");
      writeFixture(source, fixturePack());
      writeFileSync(join(source, "assets", "smuggled.png"), SPRITE_BYTES);
      const { pack, manifest } = fixturePack();

      expect(verifyPackOnDisk(source, pack, manifest)).toContainEqual(
        expect.stringContaining("Unmanifested asset file"),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
