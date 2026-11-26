"""Maneki 对已激活普通账本的访问。身份检查和证据可见性归属 EverNook。"""
from __future__ import annotations

import base64
from dataclasses import asdict
import json
from pathlib import Path
import re

from evernook.context import ContextBundle, OmittedEvidence
from evernook.models import (AttachmentInfo, CaptureReceipt, Event, MemoryFailure, Receipt,
                             Source, StoredMessage)
from evernook.service import ServiceClient, client_access


class ServiceLedger:
    def __init__(self, config: Path):
        self.client = ServiceClient(config)
        self.root = self.client.config.parent

    def access_from_file(self, path):
        return client_access(self.client.config, path)

    def handshake(self, access):
        return self.client.call(access, "handshake", {})

    def submit_capture(self, access, envelope):
        attachments = []
        for attachment in envelope.attachments:
            wire = asdict(attachment)
            chunks = wire.pop("chunks")
            wire["chunks_base64"] = None if chunks is None else [base64.b64encode(chunk).decode("ascii") for chunk in chunks]
            attachments.append(wire)
        value = self.client.call(access, "capture", {"event": asdict(envelope.event), "kind": envelope.kind,
            "input_id": envelope.input_id, "tool_name": envelope.tool_name, "attachments": attachments,
            "provided": envelope.provided, "text_chunks": envelope.text_chunks})
        return CaptureReceipt(**{**value, "message": Receipt(**value["message"]),
            "attachments": tuple(AttachmentInfo(**item) for item in value["attachments"]), "gaps": tuple(value["gaps"])})

    def read(self, access, message_id):
        try:
            value = self.client.call(access, "read", {"message_id": message_id})
        except MemoryFailure as error:
            if error.code == "message_not_found":
                return None
            raise
        event = value["event"]
        return StoredMessage(Event(**{**event, "source": Source(**event["source"])}), Receipt(**value["receipt"]))

    def context(self, access, query, limit, as_of, counter):
        value = self.client.call(access, "context", {"query": query, "model_id": counter.model_id,
            "max_tokens": limit, "as_of": as_of, "mode": "normal", "timeout": 4}, timeout=10)
        return host_bundle(value, limit, as_of, counter)


def host_bundle(value, limit, as_of, counter):
    """服务负责挑选及回源；仅以本地消费模型对原样交付的载荷重新计数。"""
    invalid = MemoryFailure("invalid_service_context")
    if (not isinstance(value, dict) or value.get("as_of") != as_of or value.get("mode") != "normal"
            or type(value.get("token_limit")) is not int or value["token_limit"] != limit
            or type(value.get("used_tokens")) is not int or not 0 <= value["used_tokens"] <= limit
            or type(value.get("complete")) is not bool or not isinstance(value.get("payload"), str)
            or type(value.get("evidence_count")) is not int or not 0 <= value["evidence_count"] <= 256
            or not isinstance(value.get("counter_id"), str) or not re.fullmatch(r"local-tokenizer-v1-[0-9a-f]{64}", value["counter_id"])
            or not isinstance(value.get("degraded"), list) or len(value["degraded"]) > 64
            or not all(isinstance(s, str) and len(s) <= 200 for s in value["degraded"])
            or not isinstance(value.get("omitted"), list) or len(value["omitted"]) > 256):
        raise invalid
    omitted = []
    for item in value["omitted"]:
        if (not isinstance(item, dict) or set(item) != {"reason", "evidence_id"}
                or not all(isinstance(s, str) and len(s) <= 200 for s in item.values())):
            raise invalid
        omitted.append(OmittedEvidence(**item))
    payload = value["payload"]
    if len(payload.encode("utf-8")) > 128 * 1024:
        raise invalid
    if payload:
        try:
            envelope = json.loads(payload)
        except (ValueError, RecursionError):
            raise invalid from None
        if (not isinstance(envelope, dict) or envelope.get("kind") != "untrusted_memory_context"
                or envelope.get("counter_id") != value["counter_id"] or envelope.get("as_of") != as_of
                or envelope.get("mode") != "normal" or not isinstance(envelope.get("items"), list)
                or len(envelope["items"]) != value["evidence_count"]):
            raise invalid
        for item in envelope["items"]:
            if (not isinstance(item, dict) or item.get("kind") != "evidence" or not isinstance(item.get("data"), dict)
                    or not isinstance(item.get("evidence_id"), str) or not re.fullmatch(r"[A-Za-z0-9_.:/-]{1,200}", item["evidence_id"])):
                raise invalid
    elif (value["evidence_count"] or value["used_tokens"] or value["complete"]
          or "context_envelope_over_budget" not in value["degraded"]):
        raise invalid
    count = counter.count(payload)
    if type(count) is not int or not 0 <= count <= limit:
        raise MemoryFailure("host_context_over_budget")
    return ContextBundle(payload, count, limit, counter.counter_id, "normal", as_of, tuple(omitted),
                         tuple(value["degraded"]), value["complete"], value["evidence_count"])
