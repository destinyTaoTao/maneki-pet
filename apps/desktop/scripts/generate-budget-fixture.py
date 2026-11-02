"""生成 #54 的大 PNG 探针；仅写入调用者指定的新文件，依赖 FFmpeg。"""

import argparse
import hashlib
import struct
import subprocess
import tempfile
import zlib
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="maneki-budget-") as temporary:
        base = Path(temporary) / "base.png"
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=2048x4096", "-frames:v", "1", "-threads", "1", "-y", str(base)],
            check=True,
        )
        original = base.read_bytes()
        if original[-12:] != b"\x00\x00\x00\x00IEND\xaeB`\x82":
            raise ValueError("unexpected PNG end chunk")
        kind = b"vpAg"  # 合法的私有 ancillary chunk；不影响像素。
        payload = b"x" * (1024 * 1024)
        chunk = struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
        with args.output.open("xb") as target:
            target.write(original[:-12])
            for _ in range(60):
                target.write(chunk)
            target.write(original[-12:])
    digest = hashlib.sha256()
    with args.output.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    print(f"{args.output.stat().st_size} bytes sha256={digest.hexdigest()}")


if __name__ == "__main__":
    main()
