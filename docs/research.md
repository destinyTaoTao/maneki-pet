# 调研笔记：我们向这些项目学什么

> 调研时间：2026-10。本笔记记录各项目对我们的具体启发，避免"只抄外观不学骨架"。

## [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（约 5k★，MIT）

DeepSeek Harness 里的"大肥鱼"桌宠插件，本项目最直接的参考。

**它的做法**：
- 形象用 **VP9-Alpha 透明视频**（非 Live2D/精灵图），100+ 段动画按权重无缝衔接
- 三种运行形态：DSH web overlay / Electron 透明窗 / 完全独立的绿色包
- Cordis 插件系统 + 开放两条 API（本机 HTTP + 页内服务），附 OpenAPI 3.1
- 跟随 harness 会话六档状态切动画（思考/工作/整理/等待/成功/出错）
- "提示词配方 → 素材生成管线 → 插件成品"三件套，人人可复现自制宠物

**我们借鉴**：透明视频动画链、状态驱动、三形态架构、开放 API 带文档、可复现素材管线。
**我们的增量**：不绑定单一 harness（适配器契约 + MCP）；从"被动展示"升级为"主动助理"（语音、记事、任务派发）。

## [pooriaanv/claudeBuddy](https://github.com/pooriaanv/claudeBuddy)

Tauri 桌宠，Agent（Claude Code/Codex）完成或需要关注时来"敲门"。

**我们借鉴**：Agent 完成时的**主动打扰式提醒**是核心价值时刻；Tauri 做桌宠壳的可行性。

## [Xiaooolong/code-pet](https://github.com/Xiaooolong/code-pet)

手绘火柴人透明窗，实时感知 Claude Code 状态切动画。

**我们借鉴**：hooks 感知 harness 状态是最轻量的接入路径（Claude Code hooks → 事件总线）。

## [agentscope-ai/QwenPaw](https://github.com/agentscope-ai/QwenPaw)

"Your Personal AI Assistant"——桌宠形态个人助理，带日程/文档/浏览器等技能。

**我们借鉴**：技能（Skill）体系做扩展点；桌宠作为助理的"脸"而非全部。

## [dev-zyl/LingoPet](https://github.com/dev-zyl/LingoPet)

轻量 Tauri 桌宠：多宠管理、AI 聊天、提醒/待办、专注计时、宠物市场、动作制作工具。

**我们借鉴**：提醒/待办融入桌宠的产品形态；"宠物市场"作为生态终局的参照。

## [TopSea/Alive](https://github.com/TopSea/Alive)

可私有化部署的 AI 桌宠，自选 LLM、自定义场景脚本。

**我们借鉴**：**私有化/本地优先**是用户信任的底线（我们更进一步：记忆语音全本地，云端显式可选）。

## [Lazily01/desktop-pet](https://github.com/Lazily01/desktop-pet)

FastMCP + 视觉 LLM 的"智能阿尼亚"悬浮球：语音指令、能看屏幕、能动手。

**我们借鉴**：MCP 作为桌宠的能力总线（我们双向化：宠物既暴露 MCP 工具，也通过适配器调 harness）。

## 其他观察（clawd-on-desk 等）

社区还有"像素猫监视 Claude Code/Codex/Cursor"、"喂 token 长大"等玩法（见 [desktop-pet topic](https://github.com/topics/desktop-pet)），印证：
1. "Agent 干活我盯梢"是被反复验证的高频需求 → 我们把它做成一等公民（Task Broker）
2. 成长/养成系（喂 token）适合作为后期彩蛋，不进核心

## 2026-10-30 复核补充

上文保留为初始调研快照；以下修正影响架构判断的表述，不将外部项目能力当作 Maneki 已实现功能。

- [dsh-pet 当前 README](https://github.com/PC2005-cloud/dsh-pet/blob/main/README.md) 已包含主动碎碎念、对话/持久化记忆、语音与待办提醒。前文“从被动展示升级为主动助理”的差异描述不准确；Maneki 计划重点验证跨 harness 的任务代理、明确授权及故障恢复，而不以其他项目没有主动能力为前提。
- dsh-pet 的动画链、数据动作包、素材配方和 overlay/桌面复用仍值得借鉴；其 README 描述的本机无鉴权 HTTP 接口不沿用。Maneki 采用回环、令牌/scope、Host/Origin 检查，也不将宠物表达接口当作 harness 任务派发 API。
- [Tauri Node sidecar](https://v2.tauri.app/learn/sidecar-nodejs/) 提供 TS 本地服务的部署参考，但需要另外验证打包、生命周期和总资源开销；浏览器/其他项目的透明播放效果不能替代 Maneki 的 WebView 三平台验收。
- [MCP 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) 区分 stdio 与 Streamable HTTP。Maneki 初期选 stdio 表达桥，双向任务接入另走经验证的 Adapter，不承诺一行 MCP 配置完成全部场景。
- [Node VM 文档](https://nodejs.org/api/vm.html) 明确 VM 不用于不可信代码安全隔离；权限清单、Worker 或子进程本身也不作为 Maneki 的第三方代码沙箱承诺。

这些条目来自官方说明/项目 README 静态核对，未执行外部项目。后续接入记录需补具体版本、平台、真实调用与审批拒绝证据，不能用调研笔记代替联调验收。
