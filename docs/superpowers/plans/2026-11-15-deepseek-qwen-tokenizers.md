# DeepSeek / Qwen Tokenizers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 用户选择按推荐推进、尽快阶段收尾；沿用 main，保护既有改动。

**Goal:** 增加按 checkpoint 固定的本地真实计数，独立身份验证保存与有来源召回。

**Architecture:** Python 受信模型白名单选择固定文件/哈希，Runtime 将 counter_id 绑定到请求模型；无隐式下载、近似或回退。

**Tech Stack:** Python 3.14、可选 tokenizers 0.22.2、既有 tiktoken 0.12.0、TypeScript Runtime。

**Spec:** docs/architecture.md §10.3 的 2026-11-15 DeepSeek / Qwen 增量。

## Constraints / Review Focus

- 固定官方 revision 和词表哈希；不将 DeepSeek 旧 CDN 词表或其他 Qwen 别名冒充实际版本。
- 哈希校验与解析使用同一批有界字节，拒绝被替换文件；无下载、remote code、填充或截断。
- Runtime 必须拒绝“已知但不匹配请求模型”的 counter_id。
- 只统计 memory payload，不宣称消息模板/账单精确；现有 OpenAI、显式保存与故障降级兼容。
- 独立新库/凭证，不读正式记忆；真实收费调用只用已授权测试模型及合成内容，数量有界；无 Qwen 服务时如实保留人工项。

### Task 1: Tokenizer 及模型绑定

**Files:** Python tokenizer.py / pyproject.toml / tests；Runtime assistant-memory.ts / child tests。

**Interfaces:** create_counter(model) 保留 count(text)/counter_id；checkedRecall(raw, model?) 新增可选消费模型，实际 recall 必传。

- [ ] 写真实词表计数、特殊 token/Unicode、缺包/错哈希/未知模型及跨模型 counter 红测并确认失败。
- [ ] 实现固定本地加载与精确模型/counter 匹配，复跑 Python 与 Runtime 定向回归。

### Task 2: 独立验收与收尾

**Files:** 既有 real integration test、适配器 README、审计与 roadmap；实验目录不入 Git。

- [ ] 同一真实 shim/tokenizer 链分别覆盖两模型：显式配对/保存、清小招历史与摘要、重启后召回/来源、关闭召回对照。
- [ ] 新库及专属 Python 部署到独立测试身份；只对可用实际模型做有限真实调用并核对来源，无服务则保留实机项。
- [ ] 全仓 build/test/typecheck、Python suite、必要 Windows bundle；独立全变更只读复核，修复后本地 main 提交，最终列范围与剩余项。
