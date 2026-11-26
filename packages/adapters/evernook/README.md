# maneki-evernook-adapter

Maneki 桌宠的 EverNook 适配器 shim 实现 `evernook.adapters.surface.AdapterSurface`。未激活的普通库使用嵌入式接口。已激活账本通过本机服务访问，要求该版本提供普通 `handshake`、`capture`、`read` 和 `context` 操作。

## 前置

- Windows 本机 + Python 3.14（EverNook 契约要求）
- EverNook checkout（`C:\myProject\evernook`）以 editable 方式安装进 venv：

```powershell
py -V:Astral/CPython3.14.4 -m venv C:\maneki-lab\venv-py314
C:\maneki-lab\venv-py314\Scripts\python.exe -m pip install -e C:\myProject\evernook pytest
C:\maneki-lab\venv-py314\Scripts\python.exe -m pip install -e 'C:\myProject\maneki-pet\packages\adapters\evernook[openai-tokenizer,hf-tokenizer]'
```

## 测试与验收

```powershell
$env:MANEKI_TOKENIZER_DATA_DIR = '<已显式准备词表的绝对目录>'
C:\maneki-lab\venv-py314\Scripts\python.exe -m pytest C:\myProject\maneki-pet\packages\adapters\evernook\tests -v
```

测试使用临时合成库，独立 owner 通过 `profile_runtime/profile_access` 为当前 EverNook 符合性套件准备画像 fixture；适配器自身仍仅持有 recall/capture。真实 tokenizer 回归需先按下文显式准备词表；符合性套件的合成 counter 只验证对象接口契约，不代表模型计数。

conformance CLI 只接受隔离模式，创建临时合成库与独立 owner/profile fixture；不接受 `--config`/`--access`，避免诊断读写个人库：

```powershell
C:\maneki-lab\venv-py314\Scripts\python.exe -m maneki_evernook_adapter conformance --isolated
```

## CLI（供 Maneki TS 运行时以 JSON stdin/stdout 子进程调用）

| 命令 | 输入 | 输出 |
|---|---|---|
| `pair --client-id --entry` | — | 配对结果 |
| `capture-message` | Event JSON | 消息回执 |
| `capture-tool --kind tool_call\|tool_result --tool-name --input-id` | `{event, attachments?}` | 工具事件回执（含缺口） |
| `read-back --message-id` | — | 原文/状态 |
| `inject` | `{protocolVersion:1,query,model,tokenLimit}` | 有界 ContextBundle（untrusted_memory_context 信封）及最终来源 |
| `covered` / `gaps` | — | 覆盖与缺口披露 |
| `experience-span --message-id --start --end` | — | EvidenceSpan（经验草案来源） |
| `conformance --isolated` | — | `isolated:true`、`counter_scope:synthetic_contract_only` 的全套件报告 |

覆盖范围：文本轮次与工具事件；gaps 披露语音/ASR、视觉、Live2D、平台写操作执行过程、运营数据导出原件。

普通命令必须显式提供 `--config`，可提供同库内的 `--access`。嵌入模式首次部署显式执行 `pair`。服务模式下，由可信操作者在 EverNook 使用 `service-pair` 预配 `maneki-desktop` / `maneki`，将返回的 access 文件路径填入小招，再点击配对核验。管理员材料留在 EverNook。每次启动 shim 均检查实际身份、入口与作用域，拒绝其他身份或超出 capture/recall 的权限。服务离线时采集和召回失败，停止服务后持久激活标记继续生效。

服务端通过 `--context-config` 绑定与小招所选模型同名的 tokenizer，并将普通上下文预算配置为至少小招请求的值。小招只接收普通证据信封；服务保留原始载荷中的计数器身份，小招以固定哈希验证过的本地词表复算同一载荷，按实际消费计数和请求上限验收。服务未配置上下文时仍可保存或按 ID 回读。服务模式暂不支持由小招另传经验清单。

`inject` 拒绝未知字段及旧 `{policy,counter}` 形状；query 最长 4000 字符，tokenLimit 为 128..2048 整数。生产时间取当前 UTC；内部 Python `inject(query, policy, counter)` 继续接受 TokenCounter 对象，构造器的 clock 仅为测试 seam。固定策略 recent_days=30、recent_target_chars=4000、pinned/persona/profile/topic 预算为 0，不自动生成画像。返回 `payload/used_tokens/token_limit/omitted/degraded/complete/counter_id/as_of/sources`；sources 只提取最终 payload.items 的 evidence_id，去重且最多 8 个，不含被预算淘汰的候选。写入回执保留 owning 的 message_id、original_saved 与 status，敏感投影不能伪报原文已保存。

输入最多 64 KiB UTF-8，输出最多 128 KiB；超限、参数或库错误均返回结构化 JSON 和退出码 1，不输出原始异常、stderr、路径或 token。执行中断后的写入结果须由调用端视为未知，不能换 ID 重放。

## 离线 tokenizer（需显式安装与准备）

默认 shim 无 tokenizer 依赖；OpenAI 模型召回使用可选 extra `openai-tokenizer`（固定 `tiktoken==0.12.0`）。该组合只支持 `gpt-4o`、`gpt-4o-mini`、`gpt-4o-2024-05-13`、`gpt-4o-2024-08-06`、`gpt-4o-mini-2024-07-18`，按官方 o200k_base 映射计数。计数针对记忆 payload 文本，不是供应商整条请求的账单保证。

将公开 [o200k_base.tiktoken 词表](https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken) 显式保存到用户选择的本地目录，并设置 `MANEKI_TOKENIZER_DATA_DIR`。未设置时查找包内 `tokenizer_data/o200k_base.tiktoken`，仓库不捆绑大词表。文件上限 8 MiB，SHA-256 必须为 `446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d`。目录来自受信进程环境；JSON 不接受路径、类或模块名。缺包、版本不符、词表缺失/哈希错误、未知模型统一 `tokenizer_unavailable`，不回退字符估算、不调用网络、不自动下载。

实现直接用本地 BPE ranks 构造 `tiktoken.core.Encoding`，不调用可能加载插件或下载的 `get_encoding`/`encoding_for_model`。pattern/special tokens 与白名单映射依据 [OpenAI tiktoken 0.12.0 openai_public.py](https://github.com/openai/tiktoken/blob/0.12.0/tiktoken_ext/openai_public.py) 和 [model.py](https://github.com/openai/tiktoken/blob/0.12.0/tiktoken/model.py)，衍生定义许可保存在 `maneki_evernook_adapter/LICENSE.tiktoken`。词表仅完整性校验不证明分发者身份，应从官方来源准备。

### DeepSeek / 小 Qwen（固定版本）

安装可选 extra `hf-tokenizer`（`tokenizers==0.22.2`）；与 OpenAI extra 可并存。将下表官方 JSON 显式保存到同一受信词表目录，按规定重命名，运行时不联网下载、不加载模型权重或 remote code。

| 消费模型 ID | 固定模型 revision / 本地文件 | SHA-256 |
|---|---|---|
| `deepseek-flash` | [DeepSeek-V4.1-Flash-1017@08c8657f](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/resolve/08c8657f02291e11b6f6b63e0e16014f8e748518/tokenizer.json)；`deepseek-v4.1-flash-1017.tokenizer.json` | `c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b` |
| `Qwen/Qwen3-0.6B` | [Qwen3-0.6B@c1899de2](https://huggingface.co/Qwen/Qwen3-0.6B/resolve/c1899de289a04d12100db370d81485cdf75e47ca/tokenizer.json)；`qwen3-0.6b.tokenizer.json` | `aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4` |

每份 JSON ≤16 MiB，校验同一批字节再解析，关闭截断/填充。Runtime 要求返回的 counter_id 与本次消费模型一致，不能拿另一已支持 counter 冒充。现有 JSON v1、设置和数据格式不变；没有正确环境/词表时保持明确降级，显式保存仍独立可用。

DeepSeek 在线别名按 [2026-11-15 官方映射](https://api-docs.deepseek.com/)确认；官方 token_usage 页的旧 V4 ZIP 与 1017 的 added tokens 不同，不接受替代。供应商未来更换别名模型时须重新核验本地映射。Qwen 的本机推理服务须实际加载此 checkpoint，并以该模型 ID 提供服务；不把 `qwen-plus`、Ollama 别名或其他商业/本地模型自动视为等价。

许可见固定 revision 的 [DeepSeek MIT](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/blob/08c8657f02291e11b6f6b63e0e16014f8e748518/LICENSE)、[Qwen Apache-2.0](https://huggingface.co/Qwen/Qwen3-0.6B/blob/c1899de289a04d12100db370d81485cdf75e47ca/LICENSE) 和 [Tokenizers Apache-2.0](https://github.com/huggingface/tokenizers/blob/v0.22.2/LICENSE)。仓库不分发模型词表。这里只统计 memory payload，包含角色/思考/工具模板的完整请求与实际账单另计。
