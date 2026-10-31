# maneki-evernook-adapter

Maneki 桌宠的 EverNook 适配器 shim：实现官方 `evernook.adapters.surface.AdapterSurface`，通过 `evernook.adapters.conformance.ConformanceSuite` 全套件验收（adapter-conformance-v1 §5）。**EverNook 仓库零改动**。

## 前置

- Windows 本机 + Python 3.14（EverNook 契约要求）
- EverNook checkout（`C:\myProject\evernook`）以 editable 方式安装进 venv：

```powershell
py -V:Astral/CPython3.14.4 -m venv C:\maneki-lab\venv-py314
C:\maneki-lab\venv-py314\Scripts\python.exe -m pip install -e C:\myProject\evernook pytest
C:\maneki-lab\venv-py314\Scripts\python.exe -m pip install -e C:\myProject\maneki-pet\packages\adapters\evernook
```

## 测试与验收

```powershell
C:\maneki-lab\venv-py314\Scripts\python.exe -m pytest C:\myProject\maneki-pet\packages\adapters\evernook\tests -v
```

conformance 全套件（新外壳验收标准，adapter-conformance-v1 §5）：

```powershell
C:\maneki-lab\venv-py314\Scripts\python.exe -m maneki_evernook_adapter conformance --config <runtime.json> --access <access.json>
```

## CLI（供 Maneki TS 运行时以 JSON stdin/stdout 子进程调用）

| 命令 | 输入 | 输出 |
|---|---|---|
| `pair --client-id --entry` | — | 配对结果 |
| `capture-message` | Event JSON | 消息回执 |
| `capture-tool --kind tool_call\|tool_result --tool-name --input-id` | `{event, attachments?}` | 工具事件回执（含缺口） |
| `read-back --message-id` | — | 原文/状态 |
| `inject` | `{query, policy, counter}` | ContextBundle（untrusted_memory_context 信封） |
| `covered` / `gaps` | — | 覆盖与缺口披露 |
| `experience-span --message-id --start --end` | — | EvidenceSpan（经验草案来源） |
| `conformance` | — | 全套件报告（不通过退出码 1） |

覆盖范围：文本轮次与工具事件；gaps 披露语音/ASR、视觉、Live2D、平台写操作执行过程、运营数据导出原件。
