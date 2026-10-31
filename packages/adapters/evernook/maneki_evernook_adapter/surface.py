"""Maneki 桌宠的 EverNook 适配器：实现官方 AdapterSurface，忠实 adapter-conformance-v1 语义。

- pair：经可信本地 pair_client 获得独立调用端身份，默认作用域 HARNESS_DEFAULT_SCOPES=(recall, capture)。
- capture：整轮缓冲后发布、原文保真；工具事件（tool_call/tool_result）经采集信封关联已存在的输入。
- inject：走 ContextBuilder + 显式注入清单（experience_ids，由 Maneki 技能包启用/停用登记维护），
  真实 tokenizer 计数、超预算显式 omitted；记忆载荷永远是 untrusted_memory_context 信封内的证据。
- gaps：结构化披露未覆盖的宿主事件，covered ∩ gaps = ∅ 且 gaps 非空。
"""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from evernook import Capture
from evernook.adapters import AdapterGap, AdapterSurface
from evernook.context import ContextBundle, ContextBuilder, ContextPolicy, SemanticRecall
from evernook.models import Access, CaptureReceipt, Event, MemoryFailure, StoredMessage
from evernook.runtime import HARNESS_DEFAULT_SCOPES, MemoryRuntime, pair_client

TOOL_KINDS = ("tool_call", "tool_result")
COVERED_EVENTS = (
    "text_user_turn",
    "text_assistant_turn",
    "whole_turn_buffered_publish",
    "tool_call_event",
    "tool_result_receipt",
)
GAPS = (
    AdapterGap("voice_asr_transcript", "语音/ASR 转写原文由宿主持有，语音采集契约未接入 Maneki"),
    AdapterGap("asr_confidence", "文本采集契约当前没有置信度字段"),
    AdapterGap("vision_frame", "多模态帧不在记忆层范围"),
    AdapterGap("live2d_interaction", "Live2D 交互事件是 Shell 内部事件"),
    AdapterGap("platform_write_action_execution", "平台写操作仅人工发布，执行过程不经采集通道"),
    AdapterGap("ops_data_raw_export", "运营数据人工导出原件不进账本，仅约定 JSON 模板解析后采集"),
)


class ManekiSurface(AdapterSurface):
    """Maneki 桌宠外壳的采集/注入实现：文本轮次与工具事件覆盖，语音/视觉为已披露缺口。"""

    name = "maneki-desktop-v1"

    def __init__(
        self,
        config_path: Path,
        access_path: Path | None = None,
        *,
        client_id: str = "maneki-desktop",
        entry: str = "maneki",
        experience_ids: tuple[str, ...] = (),
    ):
        self.runtime = MemoryRuntime(config_path)
        self.access_path = access_path or (self.runtime.root / "mcp-access-maneki.json")
        self._client_id = client_id
        self._entry_name = entry
        self._access: Access | None = None
        self._entry: str | None = None
        self._experience_ids = tuple(experience_ids)
        self.recall = SemanticRecall(self.runtime)

    def pair(self, client_id: str, entry: str) -> Access:
        self._access = pair_client(
            self.runtime.root / "runtime.json",
            client_id=client_id,
            entry=entry,
            access_path=self.access_path,
            scopes=HARNESS_DEFAULT_SCOPES,
        )
        self._entry = entry
        return self._access

    def _require_access(self) -> Access:
        if self._access is None:
            raise MemoryFailure("unauthorized")
        return self._access

    def _mapped(self, event: Event) -> Event:
        """宿主本地来源名映射到配对 entry 命名空间，其余字段（角色/顺序/原文）原样保留。"""
        if event.source.entry == self._entry:
            return event
        return replace(event, source=replace(event.source, entry=self._entry or self._entry_name))

    def covered_events(self) -> tuple[str, ...]:
        return COVERED_EVENTS

    def gaps(self) -> tuple[AdapterGap, ...]:
        return GAPS

    def capture(self, event: Event) -> CaptureReceipt:
        access = self._require_access()
        return self.runtime.submit_capture(access, Capture(self._mapped(event), "message"))

    def capture_tool_event(
        self,
        event: Event,
        kind: str,
        input_id: str,
        tool_name: str,
        attachments=(),
    ) -> CaptureReceipt:
        """tool_call/tool_result 采集信封：kind 限定两种工具事件，input_id 必须指向已保存输入。"""
        if kind not in TOOL_KINDS:
            raise MemoryFailure("arguments-invalid")
        access = self._require_access()
        envelope = Capture(self._mapped(event), kind, input_id, tool_name, attachments)
        return self.runtime.submit_capture(access, envelope)

    def read_back(self, message_id: str) -> StoredMessage | None:
        return self.runtime.read(self._require_access(), message_id)

    def inject(self, query: str, policy: ContextPolicy, counter: object) -> ContextBundle:
        # 注入清单（技能包启用/停用登记）在 Maneki 侧合并进 policy.experience_ids 后传入；
        # shim 不做自动相关性选择，只按给定清单构造。
        merged = (
            replace(policy, experience_ids=self._experience_ids)
            if self._experience_ids and policy.experience_ids == ()
            else policy
        )
        builder = ContextBuilder(self.runtime, self.recall, merged, counter)  # type: ignore[arg-type]
        return builder.build(self._require_access(), query, as_of="2026-10-30T12:00:00+08:00", mode="normal", timeout=20)

    def attempt_out_of_scope(self) -> str:
        try:
            self.runtime.refresh_lexical(self._require_access())
        except MemoryFailure as failure:
            return failure.code
        return "ok"

    def access(self) -> Access:
        return self._require_access()
