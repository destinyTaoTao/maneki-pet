# AGENTS.md — Maneki 开发指南（面向 AI 协作者）

> 本文档面向在本仓库工作的 coding agent（Claude Code / ZCode / dsh / 其他 harness）。
> 人类读者请从 [README.md](./README.md) 开始。本文只给事实、规则和红线，不解释背景；背景在 docs/ 下。

## 项目速览

**Maneki（小招）**——桌宠形态的个人助理 + AI 编程 harness 的任务中间人。招财猫的定位：主动招手迎接你，把结果叼回来。

一句话架构：Shell / Core / Gateway / Local Services 分工，Runtime 统一装配；Core 定义端口且不依赖具体 IO。三种运行形态（① Tauri 独立 App / ② harness overlay 插件 / ③ core npm 库）；双向通道按能力接入，MCP 表达工具不等于任务派发。

**当前状态：M1 开发中（2026-10-31）；已有 workspace、Core、内置动作包与桌面前端，原生 Tauri 尚未完成本机编译和设备验收。** 首个可用版本优先可换装桌宠 + dsh 文字任务与插件入口，pi 第二；语音/提醒独立增量。M1 继续验证透明窗、动画链与跨平台 spike；Windows 阶段出口与 macOS/Linux 支持矩阵分开。动手前必读 [docs/roadmap.md](./docs/roadmap.md) 和 [docs/architecture.md](./docs/architecture.md) 相关章节；文档定案不等于运行验收。

## 文档体系与同步规则

| 文档 | 角色 | 维护规则 |
|---|---|---|
| docs/architecture.md | 实现蓝图，**唯一事实来源** | 契约/选型/格式变更必须先改这里、单独提交，再写代码；实现与文档冲突时二者取一同步，禁止漂移 |
| docs/roadmap.md | 里程碑与验收标准 | 完成一项勾一项并补日期；范围调整在这里记录 |
| docs/research.md | 调研快照（2026-10） | 历史文档，不随实现更新；发现重要新参考可追加条目 |
| README.md | 对外门面 | 用户可见的能力/承诺变化时同步 |
| GLOSSARY.md | 纯领域术语 | 明确词义，不承载实现规范，术语变更与架构同步 |
| docs/adr/ | 已确认的重大取舍与原因 | 不取代 architecture.md，后续变更保留历史并注明取代关系 |
| docs/audits/ | 指定基线的审计证据与处置 | 区分文档修正、运行验证与未决事实，不冒充验收 |

## 技术栈（已定案，勿擅自更换）

- TypeScript monorepo + pnpm workspace，Node ≥ 22 LTS，`strict` 模式
- 桌面壳 Tauri v2（Electron 仅为备选，切换条件见 architecture §3.3）；共享 Node Runtime 可由插件独立启动，M2 验证打包/生命周期，不依赖先打开桌宠窗口
- 动画：透明视频（video-alpha）为主，spritesheet 兜底
- 存储：SQLite 单文件，放用户数据目录
- MCP：`@modelcontextprotocol/sdk`
- 语音：ASR / TTS 独立 Provider，whisper.cpp 为本地 ASR 优先项；模型/语音均可关闭，无云端静默回退；VAD/唤醒为可选增强

依赖原则：优先主流成熟库；能不加就不加；token 生成、哈希、签名验证用标准库/成熟实现，不自己发明密码学。哈希校验只证明完整性，不等于发布者身份验证。

## 目标仓库结构（随里程碑落地，禁止提前创建空目录）

```
apps/
  desktop/        # 形态①：Tauri v2 独立桌宠（M1 起）
  dsh-plugin/     # 形态②：dsh overlay 插件（M2b 首版，不依赖语音/提醒）
packages/
  core/           # 纯 TS 规则与端口（M1 PetState 先行；任务策略 M2b，对话/记忆 M3/M4）
  runtime/        # M2：装配、生命周期、鉴权、SQLite、本地服务和 Provider 实现
  gateway/        # M2：Adapter 契约、事件归一、MCP 表达桥；Task Broker 策略放 Core
  adapters/       # 各 harness 适配器 npm 包：claude-code / dsh / generic-cli…（M2 起）
```

npm scope 统一为 `@maneki-pet/*`（如 `@maneki-pet/core`）。

## 红线（任何改动不得违反）

安全（完整威胁模型见 architecture §7，此处是不可妥协子集）：

1. 本地 API 只绑 `127.0.0.1` + 安装期随机 token 鉴权。禁止绑 `0.0.0.0`、禁止"临时关掉鉴权调试"的提交进入仓库。
2. Agent/harness 返回内容一律按**数据**渲染；结构化意图也需来源、参数与授权校验，不能修改策略或代批操作。
3. 派发 confirmPolicy 默认 `ask`；首版新建任务会话、危险操作原生审批先行，不接管任意已有会话。后续 bridge 须操作级查询/执行侧单次认领通过才开放；未知操作结果不改 ID 重试。无审批保障的 Adapter 仅观察。
4. 用户数据默认本地、录音默认不落盘；“关闭 Maneki 云端能力”仅控制自身 Provider，外部 harness 数据去向另获授权，无静默云端回退。交互收费调用需显式启用，主动收费调用单独授权与限额；购买/支付仍逐次审批。日志默认脱敏。
5. 动作包为纯数据并校验权限清单、路径、资源与内容哈希；第三方可执行技能须隔离验收后开放。权限清单、普通子进程或 node:vm 不等于安全沙箱。
6. 仓库不提交密钥与个人数据（`.env` 已 ignore）。

架构不变量：

- 编译依赖向 Core 收敛：Runtime 装配 Core/Gateway/Local Services，后两者实现 Core 端口；Core 不依赖 UI、Runtime 或具体 IO。见 architecture §2。
- 新 harness 接入一律走 Adapter Contract 或 MCP 通道，不得在 Core/Shell 里写死特定 harness 的逻辑。
- 主动性引擎中"是否打扰用户"（触发器 × 防打扰预算）是确定性规则；LLM 只负责生成话术，不得决定触发与否。
- ASR、TTS、LLM 分别注入、分别禁用；不把语音/云端服务设为文字任务与提醒的前置依赖。
- 勿扰只抑制主动打扰，不禁用户主动交互；语音输出关闭、麦克风禁用独立，不能被例外覆盖。多 Shell 语音交互一个 owner，不重复采集/播报。
- 入口 clientRequestId 映射全局 brokerRequestId；恢复必须区分完整快照与仅状态，未知结果先对账，不盲重试/假交付。
- 关闭窗口/插件只断开客户端，后台继续跟踪；明确退出助理才停止自身服务，不能伪报外部任务取消。开机启动默认关。

性能预算（architecture §8）：空闲总内存 < 150MB（含 WebView/Runtime/桥）；正常负载下事件 → 动画 p95 < 300ms、提醒 → 通知调用 p95 < 1s。活跃模型资源另报；这些都是待测目标。热路径改动需对照预算评估。

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

- **新增 harness 适配器**：实现 architecture §5.1 的 `HarnessAdapter`，能力与宿主版本如实登记，放 `packages/adapters/`；先验证事件，再验证派发/会话/审批/恢复。不把候选 API 当已支持。
- **新增 Provider**：按 architecture §4.1 独立实现模型/ASR/TTS 端口，统一取消/超时/错误语义；初期放 runtime 内，不提前拆空包。
- **新增 MCP 工具**：命名 `maneki_<verb>`；只暴露表达与被授权提醒，禁止执行/审批/策略修改；`maneki_remind` 随 M4 持久化与调度落地。
- **动画/动作包**：状态名与 Core 的 PetState 枚举严格对齐，缺省回退 idle；素材走可复现管线（配方入库，渲染产物 ignore），不在仓库提交大二进制。
- **新依赖**：说明用途与替代方案对比，安全相关依赖优先零依赖或标准实现。

## Agent skills

### Issue tracker

需求、Bug 与规格票据统一记录在 GitHub Issues。
操作时优先使用已连接的 GitHub 插件工具，其次使用 gh CLI
（显式指定 --repo destinyTaoTao/maneki-pet）。
见 docs/agents/issue-tracker.md。

### Triage labels

使用五个默认状态标签。
见 docs/agents/triage-labels.md。

### Domain docs

采用 single-context：根目录 GLOSSARY.md 与 docs/adr/。
见 docs/agents/domain.md。
