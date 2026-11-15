"""固定消费模型、revision 和本地词表；从不下载或执行模型仓代码。"""
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
MAX_HF_BYTES = 16 * 1024 * 1024
HF_MODELS = {
    "deepseek-flash": (
        "deepseek-v4.1-flash-1017.tokenizer.json",
        "c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b",
        "hf-tokenizers-0.22.2-deepseek-v4.1-flash-1017-08c8657f",
    ),
    "Qwen/Qwen3-0.6B": (
        "qwen3-0.6b.tokenizer.json",
        "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",
        "hf-tokenizers-0.22.2-qwen3-0.6b-c1899de2",
    ),
}
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


class HfTokenCounter:
    def __init__(self, tokenizer, counter_id: str):
        self._tokenizer = tokenizer
        self.counter_id = counter_id

    def count(self, text: str) -> int:
        return len(self._tokenizer.encode(text, add_special_tokens=False).ids)


def _data_directory() -> Path:
    return Path(os.environ.get("MANEKI_TOKENIZER_DATA_DIR", str(Path(__file__).parent / "tokenizer_data")))


def _create_hf_counter(model: str) -> HfTokenCounter:
    try:
        if version("tokenizers") != "0.22.2":
            raise ValueError("unsupported version")
        from tokenizers import Tokenizer

        filename, expected_hash, counter_id = HF_MODELS[model]
        with (_data_directory() / filename).open("rb") as stream:
            contents = stream.read(MAX_HF_BYTES + 1)
        if len(contents) > MAX_HF_BYTES or hashlib.sha256(contents).hexdigest() != expected_hash:
            raise ValueError("invalid vocabulary")
        # 校验和解析同一批字节，不在校验后重新按路径打开，避免文件被置换。
        tokenizer = Tokenizer.from_str(contents.decode("utf-8"))
        tokenizer.no_truncation()
        tokenizer.no_padding()
        return HfTokenCounter(tokenizer, counter_id)
    except Exception:
        raise MemoryFailure("tokenizer_unavailable") from None


def create_counter(model: str) -> OpenAITokenCounter | HfTokenCounter:
    if model in HF_MODELS:
        return _create_hf_counter(model)
    if model not in MODELS:
        raise MemoryFailure("tokenizer_unavailable")
    try:
        if version("tiktoken") != "0.12.0":
            raise ValueError("unsupported version")
        from tiktoken.core import Encoding

        with (_data_directory() / "o200k_base.tiktoken").open("rb") as stream:
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
