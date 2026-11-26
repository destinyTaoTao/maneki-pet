"""已激活服务通过正式 shim 命令验收。所有配对和数据均在本次临时目录。"""
from dataclasses import asdict
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

import pytest
from evernook import MemoryFailure, initialize, pair_client
from evernook.service import ENDPOINT, ServiceClient

from maneki_evernook_adapter.service_ledger import host_bundle
from test_cli_memory import cli, event


@contextmanager
def running_service(config, *options):
    endpoint = config.parent / ENDPOINT
    before = endpoint.read_bytes() if endpoint.exists() else None
    with subprocess.Popen([os.environ.get("MANEKI_EVERNOOK_SERVICE_PYTHON", sys.executable),
            "-m", "evernook.service", "--config", str(config), *map(str, options)],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE) as process:
        try:
            stop = time.monotonic() + 15
            while not endpoint.exists() or endpoint.read_bytes() == before:
                assert process.poll() is None, process.stderr.read()
                assert time.monotonic() < stop
                time.sleep(.05)
            yield
        finally:
            process.terminate()
            process.wait(timeout=10)


def test_service_pair_capture_tool_read_revocation_and_offline(tmp_path):
    config, owner = initialize(tmp_path / "ordinary", client_id="owner", entry="owner")
    owner_path = config.parent / "mcp-access-owner.json"
    owner_path.write_text(json.dumps(asdict(owner)), encoding="utf-8")
    path = config.parent / "mcp-access-maneki.json"
    pair_client(config, client_id="maneki-desktop", entry="maneki", access_path=path, scopes=("capture", "recall"))
    capture_path = config.parent / "mcp-access-capture.json"
    capture_access = pair_client(config, client_id="capture-only", entry="capture-only", access_path=capture_path,
                                 scopes=("capture",))
    with running_service(config, "--activate-owner", owner_path):
        assert cli(config, "pair") == (0, {"paired": True})
        assert cli(config, "pair", None, "--access", str(owner_path))[0] == 1
        assert cli(config, "pair", None, "--access", str(config.parent / "missing.json"))[0] == 1
        first = event("ordinary synthetic request")
        code, saved = cli(config, "capture-message", first)
        assert code == 0 and saved["original_saved"]
        options = ("--access", str(capture_path), "--client-id", "capture-only", "--entry", "capture-only")
        assert cli(config, "pair", None, *options) == (0, {"paired": True})
        assert ServiceClient(config).call(capture_access, "handshake", {})["scopes"] == ["capture"]
        assert cli(config, "capture-message", first, *options)[0] == 0
        assert cli(config, "read-back", None, "--message-id", saved["message_id"], *options)[1]["error"]["code"] == "permission_denied"
        assert cli(config, "capture-message", first) == (0, saved)
        tool = {**event("tool result", "result"), "role": "tool", "sequence": 2}
        code, result = cli(config, "capture-tool", {"event": tool, "attachments": [
            {"attachment_id": "fixture", "label": "fixture.txt", "mime_type": "text/plain", "bytes": "synthetic"}]},
            "--kind", "tool_result", "--tool-name", "fixture", "--input-id", saved["message_id"])
        assert code == 0 and result["gaps"] == []
        assert cli(config, "read-back", None, "--message-id", result["message_id"])[1]["text"] == "tool result"
        code, correction = cli(config, "capture-message", event("synthetic correction", "correction"))
        assert code == 0
        ServiceClient(config).call(owner, "cli", {"command": "change", "input": {
            "request_id": "fixture-correction", "target_id": saved["message_id"], "expected_version": 1,
            "action": "correct", "evidence_id": correction["message_id"], "reason": "synthetic correction"}})
        assert cli(config, "read-back", None, "--message-id", saved["message_id"]) == (
            0, {"found": False, "text": None, "status": None})
    # 即使发现文件也被移走，持久激活标记仍禁止直写。
    (config.parent / ENDPOINT).unlink()
    assert cli(config, "capture-message", event("offline", "offline"))[0] == 1
    assert cli(config, "pair")[0] == 1


def test_shared_context_across_native_dsh_client_and_maneki_shim(tmp_path):
    from maneki_evernook_adapter.tokenizer import create_counter
    harness_dir = os.environ.get("MANEKI_EVERNOOK_HARNESSES")
    tokenizer_config = os.environ.get("MANEKI_QWEN_TOKENIZER_CONFIG")
    if not harness_dir or not tokenizer_config:
        pytest.skip("需要配套 dsh SDK 与本地 Qwen tokenizer 配置")
    model = "Qwen/Qwen3-0.6B"
    tokenizer = Path(os.environ["MANEKI_TOKENIZER_DATA_DIR"]) / "qwen3-0.6b.tokenizer.json"
    counter_path, policy_path = tmp_path / "counter.json", tmp_path / "context.json"
    counter_path.write_text(json.dumps({"schema_version": 1, "node": shutil.which("node"),
        "package_dir": str(Path(harness_dir) / "node_modules/@huggingface/tokenizers"), "model_id": model,
        "tokenizer_file": str(tokenizer), "tokenizer_sha256": hashlib.sha256(tokenizer.read_bytes()).hexdigest(),
        "config_file": tokenizer_config, "config_sha256": hashlib.sha256(Path(tokenizer_config).read_bytes()).hexdigest()}), encoding="utf-8")
    policy_path.write_text(json.dumps({"schema_version": 1, "tokenizer_config": str(counter_path), "policy": {
        "normal_tokens": 2048, "deep_tokens": 2048, "pinned_tokens": 0, "recent_days": 30, "recent_target_chars": 4000}}), encoding="utf-8")
    config, owner = initialize(tmp_path / "ordinary", client_id="owner", entry="owner")
    owner_path = config.parent / "mcp-access-owner.json"
    owner_path.write_text(json.dumps(asdict(owner)), encoding="utf-8")
    pair_client(config, client_id="maneki-desktop", entry="maneki", access_path=config.parent / "mcp-access-maneki.json",
                scopes=("capture", "recall"))
    dsh_path = config.parent / "mcp-access-dsh.json"
    pair_client(config, client_id="dsh", entry="dsh", access_path=dsh_path, scopes=("capture", "recall"))

    def dsh(tool, args):
        js = """
            import {MemoryClient} from './src/client.ts';
            const [cfg, name, args] = JSON.parse(process.argv[1]); const c = new MemoryClient(cfg);
            try { await c.connect(); console.log(JSON.stringify(await c.call(name,args))); }
            catch (error) { console.log(JSON.stringify({error:error.message})); }
            finally { await c.close(); }
        """
        cfg = {"python": os.environ.get("MANEKI_EVERNOOK_SERVICE_PYTHON", sys.executable), "config": str(config),
               "access": str(dsh_path), "entry": "dsh", "serviceRequired": True}
        raw = subprocess.run(["node", "--input-type=module", "-e", js, json.dumps([cfg, tool, args])],
                             cwd=harness_dir, capture_output=True, timeout=30, check=True)
        return json.loads(raw.stdout)

    query = {"protocolVersion": 1, "query": "合成暗号", "model": model, "tokenLimit": 2048}
    first, second = "合成暗号为杏黄。", "合成暗号改为海蓝。"
    with running_service(config, "--activate-owner", owner_path, "--context-config", policy_path):
        source = event(first)
        source["source"]["entry"] = "dsh"
        old = dsh("remember", {"event": source})["message_id"]
        code, read_back = cli(config, "read-back", None, "--message-id", old)
        assert code == 0 and read_back["text"] == first, read_back
        code, recalled = cli(config, "inject", query)
        assert code == 0, recalled
        assert old in recalled["sources"] and first in recalled["payload"]
        counter = create_counter(model)
        assert recalled["used_tokens"] == counter.count(recalled["payload"]) <= query["tokenLimit"]
        assert recalled["counter_id"] == counter.counter_id
        assert cli(config, "inject", {**query, "model": "deepseek-flash"})[1]["error"]["code"] == "tokenizer_model_mismatch"
        code, saved = cli(config, "capture-message", event(second, "replacement"))
        assert code == 0
        new = saved["message_id"]
        assert dsh("read", {"message_id": new})["event"]["text"] == second
        admin = ServiceClient(config)
        def change(target, action, evidence):
            return admin.call(owner, "cli", {"command": "change", "input": {"request_id": "fixture-" + action,
                "target_id": target, "expected_version": 1, "action": action, "evidence_id": evidence, "reason": "synthetic"}})
        change(old, "correct", new)
        checked = cli(config, "inject", query)[1]
        assert old not in checked["sources"] and first not in checked["payload"] and new in checked["sources"]
        assert dsh("read", {"message_id": old})["error"] == "evernook:message_not_found"
        marker = cli(config, "capture-message", event("合成控制依据", "reason"))[1]["message_id"]
        change(new, "suppress", marker)
        assert new not in cli(config, "inject", query)[1]["sources"]
        assert dsh("read", {"message_id": new})["error"] == "evernook:message_not_found"
    assert cli(config, "capture-message", event("offline synthetic"))[0] == 1
    assert "error" in dsh("read", {"message_id": marker})
    with running_service(config, "--context-config", policy_path):
        assert dsh("read", {"message_id": marker})["event"]["text"] == "合成控制依据"
        checked = cli(config, "inject", query)[1]
        assert all(i not in checked["sources"] for i in (new, old))


def test_host_recounts_exact_payload_and_verifies_service_envelope():
    class Local:
        counter_id = "local-fixture"
        def count(self, text):
            assert text == payload
            return 42
    server_counter = "local-tokenizer-v1-" + "a" * 64
    as_of = "2026-11-26T00:00:00+00:00"
    payload = json.dumps({"kind": "untrusted_memory_context", "as_of": as_of, "mode": "normal",
                          "counter_id": server_counter, "items": []})
    wire = dict(payload=payload, as_of=as_of, mode="normal", used_tokens=55, token_limit=128,
                evidence_count=0, counter_id=server_counter, complete=True, omitted=[], degraded=[])
    result = host_bundle(wire, 128, as_of, Local())
    assert (result.used_tokens, result.counter_id, result.payload) == (42, "local-fixture", payload)
    for change in ({"payload": "{}"}, {"token_limit": 256}, {"counter_id": "unverified"}, {"mode": "deep"}):
        with pytest.raises(MemoryFailure, match="invalid_service_context"):
            host_bundle({**wire, **change}, 128, as_of, Local())
    class TooLarge(Local):
        def count(self, text):
            return 129
    with pytest.raises(MemoryFailure, match="host_context_over_budget"):
        host_bundle(wire, 128, as_of, TooLarge())
