<div align="center">

# 🐱 Maneki · 小招

**一只主动招手的桌宠，也是你和 AI Agent 之间的贴心中间人**

*A beckoning-cat desktop pet that brokers tasks between you and your AI coding agents.*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Status](https://img.shields.io/badge/status-incubating-orange.svg)](./docs/roadmap.md)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)]()

</div>

> 招财猫（招き猫 / Maneki-neko）的天性就是：**主动招手迎接你，把好运带回来**。
>
> Maneki 也一样 —— 它会主动找你聊天、帮你记事到点提醒、把你的指令交给 AI 编程 Agent（dsh / Claude Code / pi / Codex …），盯着它们把活干完，再把结果叼回来交给你。

## ✨ 它能做什么

| 能力 | 说明 |
|---|---|
| 🎨 自定义形象 | 动作包（Pack）驱动：透明视频 / 精灵图皆可，AI 素材管线全程可复现，支持社区动作包 |
| 🎭 预设可爱动作 | 待机呼吸、漫游、玩耍、庆祝、睡觉……按宠物状态与权重无缝衔接，交互带物理反馈（点击、拖拽、甩抛） |
| 💬 主动交流 | 主动性引擎：到点提醒、任务完成、久等输入、节日问候；带防打扰预算（静音时段 + 频率上限） |
| 🎙️ 语音对话 | 按键说话 / 可选唤醒词；本地（whisper.cpp）或云端 ASR/TTS 可插拔；任务完成主动语音播报 |
| 📝 记事与提醒 | 「小招帮我记一下……」→ 本地 SQLite 持久化，到点气泡 + 语音 + 系统通知多通道送达 |
| 🤝 Agent 中间人 | 接收你的语音/文字指令 → 派发给 harness → 盯进度切动画 → 完成后通知你并交付产物 |
| 🔌 多 harness 接入 | 适配器契约（Adapter Contract）+ MCP 双通道：dsh / Claude Code / pi / 任意 MCP 宿主 |
| 🧩 插件化 | 技能（Skill）插件 + 动作包 + 皮肤，权限清单沙箱，全部本地安装 |

## 🎯 设计原则

- **安全第一**：API 只绑 127.0.0.1 + 安装期随机令牌；破坏性操作必须经你确认；Agent 输出永远只是数据不是指令（防提示注入）。
- **可扩展**：渲染层 / 助理核心 / 适配网关 / 本地服务 四层解耦，动作包、技能、适配器皆可插拔。
- **高性能**：桌面壳优先 Tauri v2（系统 WebView），空闲常驻内存目标 < 150MB，动画无解码抖动。
- **易接入**：新 harness 只需一个适配器 npm 包，或零代码——一行 MCP 配置。

## 🏗️ 架构总览

```
┌──────────────────────────────────────────────────────────┐
│  Pet Shell  渲染层（Tauri v2 透明窗 / 浏览器 overlay）      │
│  透明视频·精灵图动画链 · 气泡对话 · 语音面板 · 托盘           │
├──────────────────────────────────────────────────────────┤
│  Assistant Core  助理核心（纯 TS，可独立成库嵌入宿主）        │
│  人设与对话(LLM) · 主动性引擎 · 记忆与提醒 · 技能系统          │
├──────────────────────────────────────────────────────────┤
│  Harness Gateway  适配网关                                 │
│  Harness Adapter Contract · 事件总线(WS) · Task Broker     │
│  adapters: dsh / claude-code / pi / generic-cli / MCP     │
├──────────────────────────────────────────────────────────┤
│  Local Services  本地服务（仅 127.0.0.1）                   │
│  HTTP+WS API(OpenAPI/令牌鉴权) · ASR/TTS 管道 · SQLite 存储  │
└──────────────────────────────────────────────────────────┘
```

完整设计见 [docs/architecture.md](./docs/architecture.md)。

## 🔌 接入方式（三种运行形态）

| 形态 | 适用场景 |
|---|---|
| ① 独立桌宠 App（默认） | 双击即用，通过本地 API / MCP / hooks 配合**任何** harness |
| ② harness 内嵌 overlay 插件 | 以 dsh 插件等形式嵌入 harness 的 web 视口，共享会话事件 |
| ③ core 库模式 | `@maneki-pet/core` 作为 npm 包被其他宿主直接集成 |

**双向通道**：harness → 宠物（状态事件驱动动画、完成通知）；宠物 → harness（派发任务、取消、查询进度）。

## 🛡️ 安全模型（摘要）

- 本机回环 + 随机令牌鉴权 + CORS 白名单，不暴露公网。
- 任务派发带确认策略（auto / ask / deny），破坏性命令必须经宠物 UI 显式确认。
- Agent 返回内容以数据渲染，动作意图只能来自结构化工具调用，防提示注入。
- 记忆、语音、提醒全部本地存储；使用云端 LLM/ASR/TTS 需显式配置，并在设置页可见可关。
- 技能与动作包带权限清单（可访问哪些 API、文件、网络），安装时明示。

## 🗺️ Roadmap（摘要）

| 里程碑 | 内容 |
|---|---|
| M0 ✅ | 仓库 + 设计文档（本仓库当前状态） |
| M1 | 最小桌宠：透明窗 + 动画链 + 托盘 + 拖拽点击 |
| M2 | 本地 API + MCP Server + 首个 harness 适配（状态联动 + 完成通知） |
| M3 | 对话与语音：LLM 气泡聊天 + ASR/TTS + 主动播报 |
| M4 | 记忆与提醒：SQLite 持久化 + 定时提醒 + 主动搭话引擎 |
| M5 | Task Broker：语音/文字指令 → 派发 harness → 交付通知（含安全确认流） |
| M6 | 生态：技能插件系统 + 动作包格式与社区市场 + 多宠 |

详见 [docs/roadmap.md](./docs/roadmap.md)。

## 💡 灵感与致谢

Maneki 站在以下优秀项目的肩膀上，感谢它们的开源精神（设计借鉴分析见 [docs/research.md](./docs/research.md)）：

- [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet) — 透明视频桌宠、插件化、开放 API 的完整范本
- [pooriaanv/claudeBuddy](https://github.com/pooriaanv/claudeBuddy) — Agent 完成时"敲门"提醒
- [Xiaooolong/code-pet](https://github.com/Xiaooolong/code-pet) — 实时感知 Claude Code 状态切动画
- [agentscope-ai/QwenPaw](https://github.com/agentscope-ai/QwenPaw) — 桌宠形态的个人助理与技能体系
- [dev-zyl/LingoPet](https://github.com/dev-zyl/LingoPet) — 轻量桌宠 + 提醒待办 + 宠物市场
- [TopSea/Alive](https://github.com/TopSea/Alive) — 可私有化部署的 AI 桌宠
- [Lazily01/desktop-pet](https://github.com/Lazily01/desktop-pet) — 语音指令 + 屏幕理解的桌宠

## 📄 许可证

- 代码：[MIT](./LICENSE)
- 官方形象素材（含「小招」默认形象）：随素材发布单独声明授权，允许非商用二创。

## 🤝 参与建设

目前处于孵化期，欢迎在 Issues 里聊聊你想要的形象、动作和 harness 适配优先级。
