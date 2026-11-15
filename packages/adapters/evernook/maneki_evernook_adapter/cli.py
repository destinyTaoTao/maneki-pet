"""有界 JSON stdin/stdout 边界；仅 pair 显式授权，错误不泄露原文或路径。"""
from __future__ import annotations

import argparse
from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import re
import sys
import tempfile

from evernook.models import MemoryFailure

from .surface import ManekiSurface

MAX_INPUT_BYTES = 64 * 1024
MAX_OUTPUT_BYTES = 128 * 1024


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise MemoryFailure("arguments-invalid")


def _invalid() -> None:
    raise MemoryFailure("arguments-invalid")


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _invalid()
        result[key] = value
    return result


def _read_stdin_json() -> dict:
    raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        _invalid()
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique,
                           parse_constant=lambda _: _invalid())
    except (UnicodeError, ValueError):
        _invalid()
    if not isinstance(value, dict):
        _invalid()
    return value


def _surface(args) -> ManekiSurface:
    if not args.config:
        _invalid()
    surface = ManekiSurface(Path(args.config), Path(args.access) if args.access else None,
                            client_id=args.client_id, entry=args.entry,
                            experience_ids=tuple(filter(None, args.experience_ids.split(","))))
    if args.command != "pair":
        surface.connect()
    return surface


def _event_from_json(value):
    from evernook.models import Event, Source

    required = {"source", "role", "sequence", "completion", "text"}
    if (not isinstance(value, dict) or not required.issubset(value)
            or set(value) - required - {"occurred_at", "sensitive", "protected_source"}):
        _invalid()
    source = value["source"]
    if not isinstance(source, dict) or set(source) != {"entry", "session", "branch", "event"}:
        _invalid()
    return Event(Source(source["entry"], source["session"], source["branch"], source["event"]),
                 value["role"], value["sequence"], value.get("occurred_at"), value["completion"],
                 value["text"], value.get("sensitive", False), value.get("protected_source", False))


def _receipt(receipt):
    return {"message_id": receipt.message.message_id, "original_saved": receipt.message.original_saved,
            "status": receipt.message.status}


def _inject_request(payload):
    if (set(payload) != {"protocolVersion", "query", "model", "tokenLimit"}
            or type(payload["protocolVersion"]) is not int or payload["protocolVersion"] != 1
            or not isinstance(payload["query"], str) or len(payload["query"]) > 4000
            or not isinstance(payload["model"], str) or not 1 <= len(payload["model"]) <= 128
            or type(payload["tokenLimit"]) is not int or not 128 <= payload["tokenLimit"] <= 2048):
        _invalid()
    return payload


def _conformance(args):
    # 在构造任何 runtime 之前检查，避免诊断触碰用户选择的库。
    if not args.isolated or args.config is not None or args.access is not None:
        _invalid()
    from evernook import MemoryRuntime, initialize
    from evernook.adapters import ConformanceSuite

    with tempfile.TemporaryDirectory(prefix="maneki-conformance-synthetic-") as directory:
        config, owner = initialize(Path(directory) / "ordinary", client_id="synthetic-owner", entry="synthetic-owner")
        surface = ManekiSurface(config)
        surface.pair("maneki-desktop", "maneki")
        report = ConformanceSuite(surface, profile_runtime=MemoryRuntime(config), profile_access=owner).run()
        return {"adapter": report.adapter, "passed": report.passed, "isolated": True,
                "counter_id": report.counter_id, "counter_scope": report.counter_scope,
                "results": [{"name": r.name, "passed": r.passed, "detail": r.detail} for r in report.results]}


def _run(argv):
    parser = _Parser(prog="maneki-evernook-adapter", allow_abbrev=False)
    parser.add_argument("command", choices=("pair", "capture-message", "capture-tool", "read-back", "inject",
                                            "covered", "gaps", "experience-span", "conformance"))
    parser.add_argument("--config")
    parser.add_argument("--access")
    parser.add_argument("--client-id", default="maneki-desktop")
    parser.add_argument("--entry", default="maneki")
    parser.add_argument("--experience-ids", default="")
    parser.add_argument("--message-id")
    parser.add_argument("--kind")
    parser.add_argument("--tool-name")
    parser.add_argument("--input-id")
    parser.add_argument("--start", type=int)
    parser.add_argument("--end", type=int)
    parser.add_argument("--isolated", action="store_true")
    args = parser.parse_args(argv)
    if args.command == "conformance":
        return _conformance(args)
    if args.isolated:
        _invalid()
    payload = None
    if args.command in {"inject", "capture-message", "capture-tool"}:
        payload = _read_stdin_json()
    if args.command == "inject":
        _inject_request(payload)
    surface = _surface(args)
    if args.command == "pair":
        surface.pair(args.client_id, args.entry)
        return {"paired": True}
    if args.command == "capture-message":
        return _receipt(surface.capture(_event_from_json(payload)))
    if args.command == "capture-tool":
        if not (args.kind and args.tool_name and args.input_id):
            _invalid()
        if set(payload) - {"event", "attachments"} or "event" not in payload:
            _invalid()
        from evernook import AttachmentInput

        attachments = tuple(AttachmentInput(item["attachment_id"], item["label"], item["mime_type"],
                                            (item["bytes"].encode("utf-8"),)) for item in payload.get("attachments", []))
        receipt = surface.capture_tool_event(_event_from_json(payload["event"]), args.kind, args.input_id, args.tool_name, attachments)
        return {**_receipt(receipt), "gaps": [gap.reason for gap in receipt.gaps]}
    if args.command in {"read-back", "experience-span"}:
        if not args.message_id:
            _invalid()
        stored = surface.read_back(args.message_id)
        if args.command == "read-back":
            return {"found": stored is not None, "text": stored.event.text if stored else None,
                    "status": stored.receipt.status if stored else None}
        if args.start is None or args.end is None:
            _invalid()
        if stored is None:
            raise MemoryFailure("not_found")
        if not 0 <= args.start < args.end <= len(stored.event.text):
            _invalid()
        return {"message_id": args.message_id, "state_version": 1, "representation": stored.receipt.representation,
                "content_version": stored.receipt.content_version, "start": args.start, "end": args.end,
                "expected_text": stored.event.text[args.start:args.end]}
    if args.command == "inject":
        from evernook.context import ContextPolicy
        from .tokenizer import create_counter

        limit = payload["tokenLimit"]
        policy = ContextPolicy(normal_tokens=limit, deep_tokens=limit, pinned_tokens=0, recent_days=30,
                               recent_target_chars=4000)
        bundle = surface.inject(payload["query"], policy, create_counter(payload["model"]))
        items = json.loads(bundle.payload)["items"] if bundle.payload else []
        sources = list(dict.fromkeys(item["evidence_id"] for item in items
                                    if isinstance(item, dict) and isinstance(item.get("evidence_id"), str)))[:8]
        return {"payload": bundle.payload, "used_tokens": bundle.used_tokens, "token_limit": bundle.token_limit,
                "omitted": [o.reason for o in bundle.omitted], "degraded": list(bundle.degraded),
                "complete": bundle.complete, "counter_id": bundle.counter_id, "as_of": bundle.as_of,
                "sources": sources}
    if args.command == "covered":
        return {"covered": list(surface.covered_events())}
    return {"gaps": [{"event_kind": gap.event_kind, "reason": gap.reason} for gap in surface.gaps()]}


def main(argv: list[str] | None = None) -> None:
    status = 0
    try:
        # 库诊断输出不可进入协议流或被原样转发给宿主。
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            result = _run(argv)
        if result.get("passed") is False:
            status = 1
    except MemoryFailure as failure:
        code = failure.code if re.fullmatch(r"[a-z][a-z0-9_-]{0,63}", failure.code) else "memory_unavailable"
        result = {"error": {"code": code, "message": "Invalid arguments" if code == "arguments-invalid" else "Memory operation failed"}}
        status = 1
    except (KeyError, TypeError, ValueError, UnicodeError):
        result = {"error": {"code": "arguments-invalid", "message": "Invalid arguments"}}
        status = 1
    except SystemExit:
        result = {"error": {"code": "arguments-invalid", "message": "Invalid arguments"}}
        status = 1
    except Exception:
        result = {"error": {"code": "memory_unavailable", "message": "Memory operation failed"}}
        status = 1
    try:
        encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
    except Exception:
        encoded = b'{"error":{"code":"memory_unavailable","message":"Memory operation failed"}}\n'
        status = 1
    if len(encoded) > MAX_OUTPUT_BYTES:
        encoded = b'{"error":{"code":"response_too_large","message":"Memory operation failed"}}\n'
        status = 1
    sys.stdout.buffer.write(encoded)
    if status:
        raise SystemExit(status)


if __name__ == "__main__":
    main()
