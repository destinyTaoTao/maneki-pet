from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import uuid
from pathlib import Path

import numpy as np
from PIL import Image

FPS = 24
FRAMES = 120
VIDEO_SIZE = 384
SPRITE_WIDTH = 10240
SPRITE_HEIGHT = 256


def recolor(rgba: np.ndarray, variant: str) -> np.ndarray:
    source = rgba.astype(np.float32) / 255.0
    rgb = source[..., :3]
    maximum = rgb.max(axis=2)
    minimum = rgb.min(axis=2)
    delta = maximum - minimum
    safe_delta = np.maximum(delta, 1e-6)
    red, green, blue = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    hue = np.zeros_like(maximum)
    red_max = (maximum == red) & (delta > 0)
    green_max = (maximum == green) & (delta > 0)
    blue_max = (maximum == blue) & (delta > 0)
    hue[red_max] = ((green - blue)[red_max] / safe_delta[red_max]) % 6
    hue[green_max] = (blue - red)[green_max] / safe_delta[green_max] + 2
    hue[blue_max] = (red - green)[blue_max] / safe_delta[blue_max] + 4
    hue *= 60
    saturation = delta / np.maximum(maximum, 1e-6)

    hue_weight = np.clip((hue - 8) / 8, 0, 1) * np.clip((50 - hue) / 8, 0, 1)
    saturation_weight = np.clip((saturation - 0.48) / 0.18, 0, 1)
    strength = hue_weight * saturation_weight * (source[..., 3] > 0.02)

    height, width = hue.shape
    yy, xx = np.ogrid[:height, :width]
    nx, ny = xx / width, yy / height
    head_zone = (nx > 0.18) & (nx < 0.82) & (ny < 0.66)
    face_zone = ((nx - 0.5) / 0.19) ** 2 + ((ny - 0.405) / 0.14) ** 2 < 1
    side_hair = ((nx < 0.43) | (nx > 0.57)) & (ny > 0.16) & (ny < 0.66)
    face_zone &= ~side_hair
    neck_zone = (nx > 0.43) & (nx < 0.57) & (ny > 0.43) & (ny < 0.58)
    head_strength = hue_weight * np.clip((saturation - 0.06) / 0.12, 0, 1) * head_zone * ~face_zone * ~neck_zone
    strength = np.maximum(strength, head_strength)

    if variant == "white":
        shade = 0.74 + 0.26 * maximum
        target = np.stack((shade, shade * 0.985, shade * 0.945), axis=2)
    else:
        shade = 0.08 + 0.31 * maximum
        target = np.stack((shade * 0.91, shade * 0.96, shade), axis=2)
    result = rgb * (1 - strength[..., None]) + target * strength[..., None]
    output = np.concatenate((np.clip(result, 0, 1), source[..., 3:]), axis=2)
    return np.rint(output * 255).astype(np.uint8)


def run(args: list[str], *, data: bytes | None = None) -> bytes:
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"{args[0]} failed: {result.stderr.decode('utf-8', errors='replace')[:2000]}")
    return result.stdout


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def recolor_image(source: Path, target: Path, variant: str) -> None:
    with Image.open(source) as image:
        rgba = np.asarray(image.convert("RGBA"))
        result = Image.fromarray(recolor(rgba, variant), "RGBA")
        result.save(target, format="PNG", compress_level=6)


def recolor_video(source: Path, target: Path, variant: str) -> None:
    probe = json.loads(run([
        "ffprobe", "-v", "error", "-count_frames", "-show_streams", "-of", "json", str(source),
    ]))
    video = next((stream for stream in probe["streams"] if stream["codec_type"] == "video"), None)
    if not video or video.get("width") != VIDEO_SIZE or video.get("height") != VIDEO_SIZE:
        raise ValueError(f"Unexpected video dimensions: {source}")
    if video.get("nb_read_frames") != str(FRAMES) or video.get("r_frame_rate") != "24/1":
        raise ValueError(f"Unexpected video frame contract: {source}")
    decoded = run([
        "ffmpeg", "-v", "error", "-xerror", "-c:v", "libvpx-vp9", "-i", str(source),
        "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
    ])
    expected = FRAMES * VIDEO_SIZE * VIDEO_SIZE * 4
    if len(decoded) != expected:
        raise ValueError(f"Unexpected decoded byte count: {source}: {len(decoded)} != {expected}")
    frames = np.frombuffer(decoded, dtype=np.uint8).reshape(FRAMES, VIDEO_SIZE, VIDEO_SIZE, 4)
    converted = np.stack([recolor(frame, variant) for frame in frames]).tobytes()
    run([
        "ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
        "-s", f"{VIDEO_SIZE}x{VIDEO_SIZE}", "-r", str(FPS), "-i", "pipe:0", "-an",
        "-frames:v", str(FRAMES), "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
        "-b:v", "0", "-crf", "28", "-auto-alt-ref", "0", str(target),
    ], data=converted)
    run(["ffmpeg", "-v", "error", "-xerror", "-c:v", "libvpx-vp9", "-i", str(target), "-f", "null", "-"])


def recolor_pack(source: Path, output: Path, variant: str, pack_id: str, name: str, version: str) -> None:
    descriptor = json.loads((source / "pet-pack.json").read_text(encoding="utf-8"))
    descriptor.update({"id": pack_id, "name": name, "version": version})
    sources = [item for clip in descriptor["clips"].values() for item in clip["sources"]]
    if not sources:
        raise ValueError("Source pack has no asset sources")
    temporary = output.with_name(f".{output.name}.tmp-{uuid.uuid4().hex}")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise FileExistsError(f"Refusing to overwrite existing candidate: {output}")
    try:
        (temporary / "assets").mkdir(parents=True)
        files = []
        for item in sources:
            relative = item["path"]
            source_asset = source / relative
            target_asset = temporary / relative
            if item["renderer"] == "video-alpha":
                recolor_video(source_asset, target_asset, variant)
            elif item["renderer"] == "spritesheet":
                recolor_image(source_asset, target_asset, variant)
                with Image.open(target_asset) as image:
                    if image.size != (SPRITE_WIDTH, SPRITE_HEIGHT):
                        raise ValueError(f"Unexpected sprite dimensions: {target_asset}")
            else:
                raise ValueError(f"Unsupported renderer: {item['renderer']}")
            files.append({"path": relative, "sha256": digest(target_asset), "bytes": target_asset.stat().st_size})
        (temporary / "pet-pack.json").write_text(json.dumps(descriptor, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        manifest = {"schemaVersion": 1, "algorithm": "sha256", "files": files}
        (temporary / "assets.manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.rename(output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main() -> None:
    parser = argparse.ArgumentParser(description="Recolor the approved Maneki catgirl assets without changing their geometry or timing.")
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--variant", choices=["white", "black"], required=True)
    parser.add_argument("--id")
    parser.add_argument("--name")
    parser.add_argument("--version")
    args = parser.parse_args()
    if args.input.is_dir():
        if not all([args.id, args.name, args.version]):
            parser.error("Pack recoloring requires --id, --name and --version")
        recolor_pack(args.input, args.output, args.variant, args.id, args.name, args.version)
    else:
        if args.output.exists():
            raise FileExistsError(f"Refusing to overwrite existing image: {args.output}")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        recolor_image(args.input, args.output, args.variant)


if __name__ == "__main__":
    main()
