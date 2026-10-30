# Maneki Roadmap

> 原则：每个里程碑都有可验证的验收标准；按序推进，但 M2/M3 可并行。

## M0 — 设计与仓库 ✅（2026-10）

- [x] 仓库、README、架构设计文档、调研笔记
- [x] 许可证（代码 MIT）

## M1 — 最小桌宠（预计 2~3 周）

目标：一只"活的"小招站在桌面上。

- Tauri v2 透明置顶窗 + 托盘（退出/静音/置顶开关）
- 动作包 v1：默认形象若干透明视频素材，状态机 idle/sleeping/celebrating
- 带权重动画链播放器 + 点击/拖拽交互
- 多显示器与 DPI 边界处理
- **技术 spike**：透明视频三平台兼容性矩阵（决定 Tauri vs Electron，见 architecture §3.4）

验收：Win/macOS/Linux 各跑通；空闲内存 < 150MB；动画无肉眼卡顿；拖拽甩抛流畅。

## M2 — 本地 API + MCP + 首个 harness 适配（预计 2~3 周）

目标：harness 动起来，宠物看得见。

- HTTP/WS 本地服务（127.0.0.1 + token）+ OpenAPI 文档
- 内置 MCP Server：`maneki_say / set_state / play / notify / remind`
- 首个适配器（Claude Code hooks 优先，CLI 最通用）：thinking/working/waiting/completed/error → 动画与气泡
- 任务完成 → 系统通知，点击跳回会话

验收：跑一个真实 Claude Code 任务，宠物全程状态联动；完成通知 < 1s 送达；未配置 token 时 API 拒绝访问。

## M3 — 对话与语音（预计 3 周）

目标：小招开口说话、听得懂你说话。

- LLM 对话（OpenAI 兼容 Provider 可配）+ 气泡 + 会话记忆窗口
- ASR（whisper.cpp 本地默认，云端可选）+ TTS；按键说话
- 主动播报：任务完成/需确认的语音通知（受静音时段约束）

验收：按住说话→提问→语音回答端到端 < 5s（本地模型）；云端 Provider 配置即用。

## M4 — 记忆与提醒（预计 2 周）

目标：「帮我记一下」闭环。

- SQLite：reminders/memories/conversations
- 意图解析（规则优先 + LLM 兜底）记事/提醒/删除/查询
- 到点多通道送达（气泡+TTS+系统通知）+ 未确认升级重提
- 主动性引擎 v1：触发器 × 防打扰预算

验收：语音记一条"半小时后提醒我看构建结果"，锁屏回来仍能收到；静音时段零打扰。

## M5 — Task Broker（预计 3~4 周）

目标：宠物成为你和 Agent 的中间人。

- 意图分流：闲聊 / 记事 / 派发任务
- confirmPolicy 安全确认流（ask 默认，高危命令强制确认）
- 派发 → 进度跟踪 → 交付（摘要 + 产物路径直达）
- generic-cli 适配器模板 + dsh overlay 插件（形态②）

验收：对小招说"让 Claude 把这个项目的 README 翻译成英文"，全程动画联动，完成后通知并给出产物路径；模拟恶意 Agent 输出夹带删除命令被拦截。

## M6 — 生态（持续）

- 技能插件系统（权限清单沙箱）
- 动作包格式定稿 + 打包工具 + 社区市场约定
- 多宠同屏、形象导入向导（AI 素材管线脚本化）
- 官方文档站
