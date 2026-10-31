"""Maneki EverNook shim 的契约测试：镜像 evernook tests/contracts/test_olv_adapter.py 的验收面。"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from evernook import AttachmentInput, Capture, Event, HARNESS_DEFAULT_SCOPES, MemoryRuntime, Source, initialize
from evernook.adapters import ConformanceSuite

from maneki_evernook_adapter import ManekiSurface


class ManekiSurfaceTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="maneki-evernook-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.config, _ = initialize(self.root / "ordinary", client_id="owner", entry="owner")

    def _paired(self, **kwargs) -> ManekiSurface:
        surface = ManekiSurface(self.config, **kwargs)
        surface.pair("maneki", "maneki")
        return surface

    def test_paired_default_scopes(self) -> None:
        surface = self._paired()
        self.assertEqual(sorted(HARNESS_DEFAULT_SCOPES), sorted(self._scopes(surface)))
        self.assertEqual(surface.access_path.name, "mcp-access-maneki.json")

    def _scopes(self, surface: ManekiSurface) -> list[str]:
        runtime = MemoryRuntime(surface.runtime.root / "runtime.json")
        return sorted(runtime._authorize(surface.access()).scopes)

    def test_full_conformance_suite_passes(self) -> None:
        surface = self._paired()
        report = ConformanceSuite(surface).run()
        for result in report.results:
            self.assertTrue(result.passed, f"{result.name}: {result.detail}")
        self.assertTrue(report.passed)

    def test_gaps_disclose_uncovered_host_events(self) -> None:
        surface = self._paired()
        kinds = {gap.event_kind for gap in surface.gaps()}
        self.assertIn("voice_asr_transcript", kinds)
        self.assertIn("platform_write_action_execution", kinds)
        self.assertFalse(kinds & set(surface.covered_events()))

    def test_tool_receipt_chain_with_metadata_attachment(self) -> None:
        surface = self._paired()
        input_event = Event(
            Source("maneki", "s-main", "main", "u-1"),
            "user",
            1,
            "2026-10-31T12:00:00+08:00",
            "complete",
            "把上一条视频的选题做成 B站发布就绪包。",
        )
        input_receipt = surface.capture(input_event)
        self.assertTrue(input_receipt.message.message_id)

        input_id = input_receipt.message.message_id
        tool_call_event = Event(
            Source("maneki", "s-main", "main", "t-1"),
            "assistant",
            2,
            "2026-10-31T12:01:00+08:00",
            "complete",
            "生成发布就绪包：视频+封面+元数据 JSON+分步指引。",
        )
        call_receipt = surface.capture_tool_event(
            tool_call_event, "tool_call", input_id, "generate-publish-ready-package"
        )
        self.assertTrue(call_receipt.message.message_id)

        metadata = '{"schemaVersion":1,"title":"M2B 验证","tags":["maneki"]}'.encode("utf-8")
        tool_result_event = Event(
            Source("maneki", "s-main", "main", "t-2"),
            "assistant",
            3,
            "2026-10-31T12:05:00+08:00",
            "complete",
            "用户已在 B站创作中心完成人工发布，稿件信息经人工确认入口采集。",
        )
        result_receipt = surface.capture_tool_event(
            tool_result_event,
            "tool_result",
            input_id,
            "manual-publish-bilibili",
            (AttachmentInput("metadata", "metadata.json", "application/json", (metadata,)),),
        )
        self.assertTrue(result_receipt.complete)
        self.assertFalse(result_receipt.gaps)
        self.assertEqual(surface.runtime.read_attachment(surface.access(), result_receipt.message.message_id, "metadata"), metadata)

    def test_tool_event_requires_known_input(self) -> None:
        surface = self._paired()
        event = Event(
            Source("maneki", "s-main", "main", "t-x"),
            "assistant",
            1,
            None,
            "complete",
            "孤儿工具事件应被明确拒绝。",
        )
        with self.assertRaises(Exception):
            surface.capture_tool_event(event, "tool_call", "missing-input", "manual-publish-bilibili")

    def test_experience_span_from_stored_tool_result(self) -> None:
        surface = self._paired()
        input_receipt = surface.capture(
            Event(
                Source("maneki", "s-main", "main", "u-2"),
                "user",
                1,
                None,
                "complete",
                "生成发布就绪包。",
            )
        )
        result_receipt = surface.capture_tool_event(
            Event(
                Source("maneki", "s-main", "main", "t-3"),
                "assistant",
                2,
                None,
                "complete",
                "用户已完成人工发布：BVID 演示、时长 03:21。",
            ),
            "tool_result",
            input_receipt.message.message_id,
            "manual-publish-bilibili",
        )
        stored = surface.read_back(result_receipt.message.message_id)
        assert stored is not None
        text = stored.event.text
        start = text.index("BVID")
        span = (
            result_receipt.message.message_id,
            1,
            stored.receipt.representation,
            stored.receipt.content_version,
            start,
            start + 4,
            text[start : start + 4],
        )
        self.assertEqual(span[6], "BVID")


if __name__ == "__main__":
    unittest.main()
