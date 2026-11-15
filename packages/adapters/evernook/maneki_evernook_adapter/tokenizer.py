"""固定模型白名单、本地校验词表和 tiktoken BPE；从不注册插件或下载数据。"""
from __future__ import annotations

import base64
import hashlib
from importlib.metadata import version
import os
from pathlib import Path

from evernook.models import MemoryFailure

MODELS = frozenset({"gpt-4o", "gpt-4o-mini", "gpt-4o-2024-05-13",
                    "gpt-4o-2024-08-06", "gpt-4o-mini-2024-07-18"})
VOCAB_SHA256 = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d"
MAX_VOCAB_BYTES = 8 * 1024 * 1024
# Derived from OpenAI tiktoken 0.12.0 openai_public.py (MIT; see LICENSE.tiktoken).
PATTERN = "|".join([
    r"[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+(?i:'s|'t|'re|'ve|'m|'ll|'d)?",
    r"[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*(?i:'s|'t|'re|'ve|'m|'ll|'d)?",
    r"\p{N}{1,3}", r" ?[^\s\p{L}\p{N}]+[\r\n/]*", r"\s*[\r\n]+", r"\s+(?!\S)", r"\s+",
])


class OpenAITokenCounter:
    counter_id = "tiktoken-0.12.0-o200k_base"

    def __init__(self, encoding):
        self._encoding = encoding

    def count(self, text: str) -> int:
        # 记忆内容全部作为普通数据；特殊 token 的文本不获得控制语义。
        return len(self._encoding.encode_ordinary(text))


def create_counter(model: str) -> OpenAITokenCounter:
    if model not in MODELS:
        raise MemoryFailure("tokenizer_unavailable")
    try:
        if version("tiktoken") != "0.12.0":
            raise ValueError("unsupported version")
        from tiktoken.core import Encoding

        directory = Path(os.environ.get("MANEKI_TOKENIZER_DATA_DIR", str(Path(__file__).parent / "tokenizer_data")))
        with (directory / "o200k_base.tiktoken").open("rb") as stream:
            contents = stream.read(MAX_VOCAB_BYTES + 1)
        if len(contents) > MAX_VOCAB_BYTES or hashlib.sha256(contents).hexdigest() != VOCAB_SHA256:
            raise ValueError("invalid vocabulary")
        ranks = {}
        for line in contents.splitlines():
            token, rank = line.split()
            ranks[base64.b64decode(token, validate=True)] = int(rank)
        encoding = Encoding(name="o200k_base", pat_str=PATTERN, mergeable_ranks=ranks,
                            special_tokens={"<|endoftext|>": 199999, "<|endofprompt|>": 200018})
        return OpenAITokenCounter(encoding)
    except Exception:
        raise MemoryFailure("tokenizer_unavailable") from None
