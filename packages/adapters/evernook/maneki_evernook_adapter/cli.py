"""Maneki EverNook shim CLI：TS 运行时经 JSON stdin/stdout 子进程调用的稳定边界。

约定沿用 EverNook CLI 惯例：严格 UTF-8、stdin 单个 JSON 对象以 EOF 结束、
拒绝未知字段；错误以 {"error":{"code","message"}} 输出并以退出码 1 结束。
命令：pair / capture-message / capture-tool / read-back / inject / covered / gaps /
experience-span / conformance。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .surface import ManekiSurface


def _fail(code: str, message: str) -> None:
    json.dump({"error": {"code": code, "message": message}}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    raise SystemExit(1)


def _read_stdin_json() -> dict:
    raw = sys.stdin.buffer.read().decode("utf-8")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        _fail("arguments-invalid", f"stdin is not valid JSON: {error}")
    if not isinstance(value, dict):
        _fail("arguments-invalid", "stdin must be one JSON object")
    return value


def _surface(args: argparse.Namespace) -> ManekiSurface:
    experience_ids = tuple(filter(None, (args.experience_ids or "").split(",")))
    surface = ManekiSurface(
        Path(args.config),
        Path(args.access) if args.access else None,
        client_id=args.client_id,
        entry=args.entry,
        experience_ids=experience_ids,
    )
    # pair_client 幂等（重复配对返回原身份）：每条命令自动就绪配对状态。
    surface.pair(args.client_id, args.entry)
    return surface


def _event_from_json(value: dict) -> object:
    from evernook.models import Event, Source

    source = value["source"]
    return Event(
        Source(source["entry"], source["session"], source["branch"], source["event"]),
        value["role"],
        value["sequence"],
        value.get("occurred_at"),
        value["completion"],
        value["text"],
        value.get("sensitive", False),
        value.get("protected_source", False),
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="maneki-evernook-adapter")
    parser.add_argument("command")
    parser.add_argument("--config", required=True)
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
    args = parser.parse_args(argv)

    surface = _surface(args)

    if args.command == "pair":
        access = surface.pair(args.client_id, args.entry)
        json.dump({"paired": True, "scopes": list(access.scopes) if hasattr(access, "scopes") else None}, sys.stdout, ensure_ascii=False, default=str)
        sys.stdout.write("\n")
        return

    if args.command == "capture-message":
        event = _event_from_json(_read_stdin_json())
        receipt = surface.capture(event)  # type: ignore[arg-type]
        json.dump({"message_id": receipt.message.message_id, "original_saved": receipt.message.original_saved, "status": receipt.message.status}, sys.stdout, ensure_ascii=False, default=str)
        sys.stdout.write("\n")
        return

    if args.command == "capture-tool":
        if not (args.kind and args.tool_name and args.input_id):
            _fail("arguments-invalid", "capture-tool requires --kind --tool-name --input-id")
        envelope = _read_stdin_json()
        event = _event_from_json(envelope["event"])
        attachments = tuple(
            __import__("evernook", fromlist=["AttachmentInput"]).AttachmentInput(
                item["attachment_id"], item["label"], item["mime_type"], (item["bytes"].encode("utf-8"),)
            )
            for item in envelope.get("attachments", [])
        )
        receipt = surface.capture_tool_event(event, args.kind, args.input_id, args.tool_name, attachments)
        json.dump({"message_id": receipt.message.message_id, "original_saved": receipt.message.original_saved, "status": receipt.message.status, "gaps": [gap.reason for gap in receipt.gaps]}, sys.stdout, ensure_ascii=False, default=str)
        sys.stdout.write("\n")
        return

    if args.command == "read-back":
        if not args.message_id:
            _fail("arguments-invalid", "read-back requires --message-id")
        stored = surface.read_back(args.message_id)
        json.dump({"found": stored is not None, "text": stored.event.text if stored else None, "status": stored.receipt.status if stored else None}, sys.stdout, ensure_ascii=False, default=str)
        sys.stdout.write("\n")
        return

    if args.command == "inject":
        payload = _read_stdin_json()
        from evernook.context import ContextPolicy

        policy = ContextPolicy(**payload["policy"])
        bundle = surface.inject(payload["query"], policy, payload["counter"])
        json.dump({"payload": bundle.payload, "used_tokens": bundle.used_tokens, "token_limit": bundle.token_limit, "omitted": [o.reason for o in bundle.omitted], "degraded": list(bundle.degraded), "complete": bundle.complete}, sys.stdout, ensure_ascii=False, default=str)
        sys.stdout.write("\n")
        return

    if args.command == "covered":
        json.dump({"covered": list(surface.covered_events())}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return

    if args.command == "gaps":
        json.dump({"gaps": [{"event_kind": gap.event_kind, "reason": gap.reason} for gap in surface.gaps()]}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return

    if args.command == "experience-span":
        if not (args.message_id and args.start is not None and args.end is not None):
            _fail("arguments-invalid", "experience-span requires --message-id --start --end")
        from evernook.candidates import EvidenceSpan

        stored = surface.read_back(args.message_id)
        if stored is None:
            _fail("not_found", f"message {args.message_id} not found")
        text = stored.event.text
        span = EvidenceSpan(
            args.message_id,
            1,
            stored.receipt.representation,
            stored.receipt.content_version,
            args.start,
            args.end,
            text[args.start : args.end],
        )
        json.dump({"message_id": span.message_id, "state_version": span.state_version, "representation": span.representation, "content_version": span.content_version, "start": span.start, "end": span.end, "expected_text": span.expected_text}, sys.stdout, ensure_ascii=False, default=str)
        sys.stdout.write("\n")
        return

    if args.command == "conformance":
        from evernook.adapters.conformance import ConformanceSuite

        report = ConformanceSuite(surface).run()
        json.dump({
            "adapter": report.adapter,
            "passed": report.passed,
            "results": [{"name": r.name, "passed": r.passed, "detail": r.detail} for r in report.results],
        }, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
        if not report.passed:
            raise SystemExit(1)
        return

    _fail("unknown-command", f"unknown command {args.command}")


if __name__ == "__main__":
    main()
