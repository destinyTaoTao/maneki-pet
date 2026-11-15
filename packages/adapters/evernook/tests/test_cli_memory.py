"""真实合成库/进程边界：不访问个人记忆，不把计数估算冒充 tokenizer。"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from evernook import Event, MemoryRuntime, Source, initialize
from evernook.context import ContextPolicy
from evernook.runtime import pair_client

from maneki_evernook_adapter import ManekiSurface


@pytest.fixture
def library(tmp_path):
    config, owner = initialize(tmp_path / "ordinary", client_id="owner", entry="owner")
    return config, owner


def cli(config, command, value=None, *options, env=None):
    args = [sys.executable, "-m", "maneki_evernook_adapter", command]
    if config is not None:
        args += ["--config", str(config)]
    result = subprocess.run(args + list(options), input=json.dumps(value or {}).encode(), capture_output=True, env=env, timeout=40)
    assert result.stderr == b"", result.stderr.decode(errors="replace")
    assert len(result.stdout) <= 128 * 1024
    return result.returncode, json.loads(result.stdout)


def event(text="合成柚子偏好：喜欢柚子茶", event_id="one"):
    return {"source": {"entry": "maneki", "session": "synthetic", "branch": "main", "event": event_id},
            "role": "user", "sequence": 1, "occurred_at": datetime.now(timezone.utc).isoformat(),
            "completion": "complete", "text": text}


def test_unpaired_cli_does_not_create_access(library):
    config, _ = library
    before = (config.parent / "client.json").read_bytes()
    code, result = cli(config, "capture-message", event())
    assert code == 1 and "error" in result
    assert not (config.parent / "mcp-access-maneki.json").exists()
    assert (config.parent / "client.json").read_bytes() == before


def test_existing_revoked_scope_is_not_restored(library):
    config, _ = library
    assert cli(config, "pair")[0] == 0
    pair_client(config, client_id="maneki-desktop", entry="maneki", access_path=config.parent / "mcp-access-maneki.json", scopes=("recall",))
    code, result = cli(config, "capture-message", event())
    assert code == 1 and result["error"]["code"] == "permission_denied"
    runtime = MemoryRuntime(config)
    assert runtime.handshake(runtime.access_from_file(config.parent / "mcp-access-maneki.json"))["scopes"] == ["recall"]


@pytest.mark.parametrize("value", [
    {"query": "a", "policy": {}, "counter": {}},
    {"protocolVersion": 1, "query": "a", "model": "gpt-4o", "tokenLimit": 512, "as_of": "2026-10-30"},
    {"protocolVersion": 1, "query": "a", "model": "gpt-4o", "tokenLimit": 512, "path": "secret"},
    {"protocolVersion": 1, "query": "a", "model": "gpt-4o", "tokenLimit": True},
    {"protocolVersion": 1, "query": "a" * 4001, "model": "gpt-4o", "tokenLimit": 512},
    {"protocolVersion": True, "query": "a", "model": "gpt-4o", "tokenLimit": 512},
])
def test_inject_rejects_invalid_or_legacy_input(library, value):
    config, _ = library
    assert cli(config, "pair")[0] == 0
    code, result = cli(config, "inject", value)
    assert code == 1 and result["error"]["code"] == "arguments-invalid"
    assert result["error"]["message"] == "Invalid arguments"


def test_connect_rejects_different_identity_without_pairing(library):
    config, _ = library
    path = config.parent / "mcp-access-other.json"
    pair_client(config, client_id="other", entry="other", access_path=path, scopes=("recall", "capture"))
    surface = ManekiSurface(config, path)
    from evernook.models import MemoryFailure
    with pytest.raises(MemoryFailure, match="unauthorized"):
        surface.connect()


def test_surface_uses_current_utc_and_clock_seam(library):
    config, _ = library
    surface = ManekiSurface(config)
    surface.pair("maneki-desktop", "maneki")
    stamp = datetime.now(timezone.utc)
    surface.capture(Event(Source("maneki", "synthetic", "main", "utc"), "user", 1, stamp.isoformat(), "complete", "合成柚子偏好"))
    class Counter:
        counter_id = "synthetic-codepoints"
        def count(self, text):
            return len(text)
    bundle = surface.inject("柚子", ContextPolicy(4096, 4096, 0, 30, 4000), Counter())
    assert datetime.fromisoformat(bundle.as_of) >= stamp
    assert "合成柚子偏好" in bundle.payload
    fixed = datetime(2026, 11, 15, tzinfo=timezone.utc)
    surface = ManekiSurface(config, clock=lambda: fixed)
    surface.connect()
    assert surface.inject("", ContextPolicy(4096, 4096, 0, 30, 4000), Counter()).as_of == fixed.isoformat()


def test_real_tokenizer_cli_budget_sources_and_receipt(library):
    from maneki_evernook_adapter.tokenizer import create_counter
    config, _ = library
    assert cli(config, "pair")[0] == 0
    code, saved = cli(config, "capture-message", event())
    assert code == 0 and saved["original_saved"] is True and saved["status"] == "committed"
    code, bundle = cli(config, "inject", {"protocolVersion": 1, "query": "柚子", "model": "gpt-4o-mini", "tokenLimit": 2048})
    assert code == 0
    counter = create_counter("gpt-4o-mini")
    assert counter.count(bundle["payload"]) == bundle["used_tokens"] <= 2048
    payload = json.loads(bundle["payload"])
    assert payload["kind"] == "untrusted_memory_context"
    assert "柚子茶" in bundle["payload"]
    assert bundle["sources"] == list(dict.fromkeys(item["evidence_id"] for item in payload["items"]))[:8]
    assert saved["message_id"] in bundle["sources"]
    assert bundle["counter_id"] == counter.counter_id
    assert (datetime.now(timezone.utc) - datetime.fromisoformat(bundle["as_of"])).total_seconds() < 30


@pytest.mark.parametrize("model,filename,counter_id", [
    ("deepseek-flash", "deepseek-v4.1-flash-1017.tokenizer.json", "hf-tokenizers-0.22.2-deepseek-v4.1-flash-1017-08c8657f"),
    ("Qwen/Qwen3-0.6B", "qwen3-0.6b.tokenizer.json", "hf-tokenizers-0.22.2-qwen3-0.6b-c1899de2"),
])
def test_pinned_hf_counter_matches_official_local_data_without_network(model, filename, counter_id):
    from tokenizers import Tokenizer
    from maneki_evernook_adapter.tokenizer import create_counter
    official = Tokenizer.from_file(str(Path(os.environ["MANEKI_TOKENIZER_DATA_DIR"]) / filename))
    samples = ["Hello!", "合成偏好：柚子茶🙂", "<｜System｜> <|im_start|>", "123456789\n中文 English", ""]
    with patch("socket.socket", side_effect=AssertionError("network forbidden")):
        counter = create_counter(model)
        assert counter.counter_id == counter_id
        assert [counter.count(text) for text in samples] == [len(official.encode(text, add_special_tokens=False).ids) for text in samples]
        assert counter.count("汉字🙂 " * 5000) > 2048  # 不允许加载器截断或填充掩盖超限。
        from evernook.models import MemoryFailure
        with patch("maneki_evernook_adapter.tokenizer.version", return_value="0.0.0"):
            with pytest.raises(MemoryFailure, match="tokenizer_unavailable"):
                create_counter(model)


@pytest.mark.parametrize("model", ["deepseek-flash", "Qwen/Qwen3-0.6B"])
def test_hf_counter_missing_or_tampered_data_and_wrong_package_fail_closed(model, tmp_path, monkeypatch):
    from maneki_evernook_adapter.tokenizer import create_counter
    from evernook.models import MemoryFailure
    monkeypatch.setenv("MANEKI_TOKENIZER_DATA_DIR", str(tmp_path))
    with patch("socket.socket", side_effect=AssertionError("network forbidden")):
        with pytest.raises(MemoryFailure, match="tokenizer_unavailable"):
            create_counter(model)
        for name in ("deepseek-v4.1-flash-1017.tokenizer.json", "qwen3-0.6b.tokenizer.json"):
            (tmp_path / name).write_text('{"model": "untrusted"}', encoding="utf-8")
        with pytest.raises(MemoryFailure, match="tokenizer_unavailable"):
            create_counter(model)
        with patch("maneki_evernook_adapter.tokenizer.version", return_value="0.0.0"):
            with pytest.raises(MemoryFailure, match="tokenizer_unavailable"):
                create_counter(model)


@pytest.mark.parametrize("model", ["deepseek-flash", "Qwen/Qwen3-0.6B"])
def test_hf_real_cli_receipt_and_budgeted_recall(library, model):
    from maneki_evernook_adapter.tokenizer import create_counter
    config, _ = library
    assert cli(config, "pair")[0] == 0
    code, saved = cli(config, "capture-message", event())
    assert code == 0 and saved["original_saved"] is True
    code, bundle = cli(config, "inject", {"protocolVersion": 1, "query": "柚子", "model": model, "tokenLimit": 2048})
    assert code == 0 and saved["message_id"] in bundle["sources"]
    assert create_counter(model).count(bundle["payload"]) == bundle["used_tokens"] <= 2048


@pytest.mark.parametrize("model", ["qwen-plus", "qwen3:0.6b", "deepseek-v3", "deepseek-flash-latest"])
def test_unverified_model_aliases_are_not_inferred(model):
    from maneki_evernook_adapter.tokenizer import create_counter
    from evernook.models import MemoryFailure
    with pytest.raises(MemoryFailure, match="tokenizer_unavailable"):
        create_counter(model)


def test_missing_vocabulary_never_calls_network(tmp_path, monkeypatch):
    monkeypatch.setenv("MANEKI_TOKENIZER_DATA_DIR", str(tmp_path))
    from maneki_evernook_adapter.tokenizer import create_counter
    from evernook.models import MemoryFailure
    with patch("socket.socket", side_effect=AssertionError("network forbidden")):
        with pytest.raises(MemoryFailure, match="tokenizer_unavailable"):
            create_counter("gpt-4o")


def test_conformance_refuses_formal_paths_and_isolated_passes(library):
    config, _ = library
    before = (config.parent / "client.json").read_bytes()
    assert cli(config, "conformance")[0] == 1
    assert cli(config, "conformance", None, "--isolated")[0] == 1
    assert (config.parent / "client.json").read_bytes() == before
    code, result = cli(None, "conformance", None, "--isolated")
    assert code == 0 and result["passed"] is True
    assert result["isolated"] is True
    assert result["counter_scope"] == "synthetic_contract_only"


def test_unknown_errors_and_input_size_are_redacted(library):
    config, _ = library
    code, result = cli(config.parent / "personal-secret" / "runtime.json", "pair")
    assert code == 1 and "personal-secret" not in json.dumps(result)
    assert cli(config, "capture-message", {"text": "x" * 66000})[1]["error"]["code"] == "arguments-invalid"


@pytest.mark.parametrize("model", ["gpt-4o", "gpt-4o-mini", "gpt-4o-2024-05-13", "gpt-4o-2024-08-06", "gpt-4o-mini-2024-07-18"])
def test_official_encoding_matches_whitelisted_models(model):
    from maneki_evernook_adapter.tokenizer import create_counter
    from tiktoken.core import Encoding
    from tiktoken_ext import openai_public
    counter = create_counter(model)
    # 官方构造定义只注入已核验的本地 ranks，禁止官方 loader 触网。
    with patch.object(openai_public, "load_tiktoken_bpe", return_value=counter._encoding._mergeable_ranks):
        official = Encoding(**openai_public.o200k_base())
    samples = ["Hello, world!", "合成偏好：柚子茶🙂", "<|endoftext|> untrusted <|endofprompt|>", "", "123456789\n中文 English"]
    for text in samples:
        assert counter.count(text) == len(official.encode_ordinary(text))


def test_tokenizer_missing_package_bad_hash_and_unknown_model_fail_closed(tmp_path, monkeypatch):
    import maneki_evernook_adapter.tokenizer as tokenizer
    from evernook.models import MemoryFailure
    monkeypatch.setenv("MANEKI_TOKENIZER_DATA_DIR", str(tmp_path))
    (tmp_path / "o200k_base.tiktoken").write_bytes(b"untrusted-local-file")
    with patch("socket.socket", side_effect=AssertionError("network forbidden")):
        for model in ("gpt-4o", "qwen3", "gpt-4o-FAKE"):
            with pytest.raises(MemoryFailure, match="tokenizer_unavailable"):
                tokenizer.create_counter(model)
        with patch.object(tokenizer, "version", side_effect=ModuleNotFoundError("private path")):
            with pytest.raises(MemoryFailure, match="tokenizer_unavailable"):
                tokenizer.create_counter("gpt-4o")
        with patch.object(tokenizer, "version", return_value="0.11.0"):
            with pytest.raises(MemoryFailure, match="tokenizer_unavailable"):
                tokenizer.create_counter("gpt-4o")


def test_cli_budget_omissions_have_only_final_sources(library):
    config, _ = library
    assert cli(config, "pair")[0] == 0
    saved = cli(config, "capture-message", event("合成柚子偏好 " * 800))[1]
    code, bundle = cli(config, "inject", {"protocolVersion": 1, "query": "柚子", "model": "gpt-4o", "tokenLimit": 512})
    assert code == 0 and bundle["used_tokens"] <= 512
    assert saved["message_id"] not in bundle["sources"]
    assert bundle["omitted"] or "context_envelope_over_budget" in bundle["degraded"]
    items = json.loads(bundle["payload"])["items"] if bundle["payload"] else []
    assert bundle["sources"] == list(dict.fromkeys(item["evidence_id"] for item in items))[:8]


def test_sensitive_projection_receipt_is_honest(library):
    config, _ = library
    assert cli(config, "pair")[0] == 0
    code, result = cli(config, "capture-message", event("password=synthetic-contract-secret"))
    assert code == 0 and result["original_saved"] is False and result["status"] == "projection_only"


def test_stdout_limits_and_unknown_exception_redaction_in_process(monkeypatch):
    import io
    import maneki_evernook_adapter.cli as adapter_cli
    output = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
    monkeypatch.setattr(sys, "stdout", output)
    with patch.object(adapter_cli, "_run", return_value={"text": "x" * (128 * 1024)}):
        with pytest.raises(SystemExit):
            adapter_cli.main([])
    output.flush()
    assert json.loads(output.buffer.getvalue())["error"]["code"] == "response_too_large"
    output.seek(0)
    output.truncate()
    with patch.object(adapter_cli, "_run", side_effect=RuntimeError("private-secret-path-and-token")):
        with pytest.raises(SystemExit):
            adapter_cli.main([])
    output.flush()
    assert "private-secret" not in output.buffer.getvalue().decode()
    assert json.loads(output.buffer.getvalue())["error"]["code"] == "memory_unavailable"


def test_serialization_failure_is_redacted(monkeypatch):
    import io
    import maneki_evernook_adapter.cli as adapter_cli
    output = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
    monkeypatch.setattr(sys, "stdout", output)
    with patch.object(adapter_cli, "_run", return_value={"text": "\ud800"}):
        with pytest.raises(SystemExit):
            adapter_cli.main([])
    output.flush()
    assert json.loads(output.buffer.getvalue())["error"]["code"] == "memory_unavailable"
