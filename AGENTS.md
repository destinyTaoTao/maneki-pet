# AGENTS.md — Maneki 开发指南（面向 AI 协作者）

> 本文档面向在本仓库工作的 coding agent（Claude Code / ZCode / dsh / 其他 harness）。
> 人类读者请从 [README.md](./README.md) 开始。本文只给事实、规则和红线，不解释背景；背景在 docs/ 下。

## 项目速览

**Maneki（小招）**——桌宠形态的个人助理 + AI 编程 harness 的任务中间人。招财猫的定位：主动招手迎接你，把结果叼回来。

一句话架构：四层解耦（Pet Shell 渲染层 / Assistant Core 纯 TS 库 / Harness Gateway 适配网关 / Local Services 本地服务），三种运行形态（① Tauri 独立 App / ② harness overlay 插件 / ③ core npm 库），双向通道（harness 事件驱动宠物动画；宠物向 harness 派发任务）。

**当前状态：M0 完成（2026-10），仓库只有设计文档，零代码。** 下一步是 M1（Tauri 透明窗 + 动画链 + 跨平台 spike）。动手前必读 [docs/roadmap.md](./docs/roadmap.md) 当前里程碑的范围与验收标准，以及 [docs/architecture.md](./docs/architecture.md) 中与任务相关的章节。

## 文档体系与同步规则

| 文档 | 角色 | 维护规则 |
|---|---|---|
| docs/architecture.md | 实现蓝图，**唯一事实来源** | 契约/选型/格式变更必须先改这里、单独提交，再写代码；实现与文档冲突时二者取一同步，禁止漂移 |
| docs/roadmap.md | 里程碑与验收标准 | 完成一项勾一项并补日期；范围调整在这里记录 |
| docs/research.md | 调研快照（2026-10） | 历史文档，不随实现更新；发现重要新参考可追加条目 |
| README.md | 对外门面 | 用户可见的能力/承诺变化时同步 |

## 技术栈（已定案，勿擅自更换）

- TypeScript monorepo + pnpm workspace，Node ≥ 22 LTS，`strict` 模式
- 桌面壳 Tauri v2（Electron 仅为备选；切换条件见 architecture §3.4，由 M1 spike 用证据定案，不凭感觉切）
- 动画：透明视频（video-alpha）为主，spritesheet 兜底
- 存储：SQLite 单文件，放用户数据目录
- MCP：`@modelcontextprotocol/sdk`
- 语音：whisper.cpp 本地优先，云端 ASR/TTS 可插拔

依赖原则：优先主流成熟库；能不加就不加；token 生成、哈希验签等安全能力用标准库/成熟实现，不自己发明密码学。

## 目标仓库结构（随里程碑落地，禁止提前创建空目录）

```
apps/
  desktop/        # 形态①：Tauri v2 独立桌宠（M1 起）
  dsh-plugin/     # 形态②：dsh overlay 插件（M5 起）
packages/
  core/           # Assistant Core：纯 TS、无 UI、无直接 IO（M2 起，PetState 先行；Persona/记忆随 M3/M4）
  gateway/        # Harness Gateway：Adapter Contract、事件总线、Task Broker、MCP Server（M2 起）
  adapters/       # 各 harness 适配器 npm 包：claude-code / dsh / generic-cli…（M2 起）
```

npm scope 统一为 `@maneki-pet/*`（如 `@maneki-pet/core`）。

## 红线（任何改动不得违反）

安全（完整威胁模型见 architecture §7，此处是不可妥协子集）：

1. 本地 API 只绑 `127.0.0.1` + 安装期随机 token 鉴权。禁止绑 `0.0.0.0`、禁止"临时关掉鉴权调试"的提交进入仓库。
2. Agent/harness 返回的内容一律按**数据**渲染；动作意图只能来自结构化工具调用并经 confirmPolicy 流程。防提示注入是设计约束，不是事后补丁。
3. 破坏性操作 confirmPolicy 默认 `ask`；危险命令（删除/强推/付费 API）强制确认且向用户展示完整命令。
4. 用户数据（记忆/语音/提醒/会话）默认全本地；云端能力必须显式配置、设置页可一键全关、日志默认脱敏。
5. 动作包与技能插件必须带权限清单，安装时校验素材/内容哈希。
6. 仓库不提交密钥与个人数据（`.env` 已 ignore）。

架构不变量：

- 依赖方向自上而下：Shell → Core → Gateway → Local Services。Core 不得依赖 UI 或具体 IO（IO 走接口注入），这是它能被三种形态复用、能单测的前提。
- 新 harness 接入一律走 Adapter Contract 或 MCP 通道，不得在 Core/Shell 里写死特定 harness 的逻辑。
- 主动性引擎中"是否打扰用户"（触发器 × 防打扰预算）是确定性规则；LLM 只负责生成话术，不得决定触发与否。

性能预算（architecture §8）：空闲内存 < 150MB；harness 事件 → 动画切换 < 300ms；提醒命中 → 通知送达 < 1s。热路径改动需对照预算评估。

## 代码与工程约定

- 标识符与 API 命名用英文；文档、代码注释、UI 文案以中文为主；UI 文案集中管理，为后续 i18n 留余地。
- 提交信息用 Conventional Commits（feat / fix / docs / refactor / test / chore），英文描述，一个提交一个意图。
- 分支：常规改动小步提交 main；里程碑级大改动或实验开 `feat/mX-<topic>` 分支。
- git 身份：仓库已局部配置提交邮箱（517493385@qq.com），勿改动 `.git/config`。
- 开发机是 Windows（Git Bash）。跨平台目标是 Win/macOS/Linux，但本机只能验证 Windows——涉及 macOS/Linux 的改动在提交说明中注明"未在本机验证"，并列出待验证点。

## AI 协作工作流

1. **动手前**：读当前里程碑（roadmap）+ 相关架构章节，确认不踩红线；信息不足以定方案时先提出，不默默假设。
2. **设计变更**（契约 / 选型 / 格式）：先改 architecture.md（必要时同步 roadmap.md），单独提交，再实现。
3. **实现**：最小可用方案，沿用已有模式；不提前抽象、不做无关重构。公共契约（Adapter Contract、动作包 manifest、本地 API、MCP 工具集）的变更是破坏性变更，提交说明中必须标注迁移方式。
4. **验证**：有代码后跑 `pnpm -r build && pnpm -r test`；对照当前里程碑验收标准逐条自查；无法验证的项明确说明边界与剩余风险。
5. **收尾**：同步文档 → Conventional Commits 提交 → push。

## 常见任务指引

- **新增 harness 适配器**：实现 architecture §5.1 的 `HarnessAdapter` 接口，capabilities 如实声明，放 `packages/adapters/`；先打通事件方向（状态联动动画），再验证 submit/cancel。
- **新增 MCP 工具**：命名 `maneki_<verb>`；只暴露表达类能力（说、演、通知、记提醒），永不暴露执行类能力（执行一律走 Adapter + confirmPolicy）。
- **动画/动作包**：状态名与 Core 的 PetState 枚举严格对齐，缺省回退 idle；素材走可复现管线（配方入库，渲染产物 ignore），不在仓库提交大二进制。
- **新依赖**：说明用途与替代方案对比，安全相关依赖优先零依赖或标准实现。
