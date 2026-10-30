# Maneki 架构设计

> 状态：v0.1 草案（M0）。本文是实现的蓝图，随里程碑演进持续修订。
> 反馈与质疑欢迎提 Issue —— 设计文档也欢迎对抗式审查。

## 1. 目标与非目标

### 目标

1. **桌宠即个人助理**：有形象、有动作、有性格；能主动交流、语音对话、记事提醒。
2. **Agent 中间人**：作为用户与 AI 编程 harness（dsh、Claude Code、pi、Codex…）之间的 broker——接收指令、派发任务、盯进度、交付产物。
3. **插件化与易接入**：新 harness 一包适配或一行 MCP 配置；形象/动作/技能皆可插拔。
4. **安全**：本机优先、最小权限、防注入、隐私数据不出本机（云端能力显式可选）。
5. **高性能**：低空闲占用、动画流畅、事件低延迟（harness 状态变化 → 宠物反应 < 300ms）。

### 非目标（明确不做）

- 不做云端 SaaS / 多用户服务；Maneki 是纯本地个人软件。
- 不做通用 IM / 全功能待办产品（只做"和宠物对话级别"的轻量记事提醒）。
- 不重造 harness：不内置模型推理编排，任务执行永远交给 harness，Maneki 只做代理与陪伴。
- v1 不做移动端。

## 2. 总体架构

四层解耦，依赖方向自上而下；`Assistant Core` 是纯 TS 库，无 UI 依赖，可被三种形态复用。

```
┌──────────────────────────────────────────────────────────┐
│  Pet Shell  渲染层                                         │
│  (tauri) 桌面透明窗 · (web) harness overlay · 动画渲染器     │
├──────────────────────────────────────────────────────────┤
│  Assistant Core  助理核心（纯 TS 库）                        │
│  Persona · Dialogue · Proactivity · Memory · Skills        │
├──────────────────────────────────────────────────────────┤
│  Harness Gateway  适配网关                                  │
│  Adapter Registry · Event Bus · Task Broker · MCP Server   │
├──────────────────────────────────────────────────────────┤
│  Local Services  本地服务                                   │
│  HTTP/WS API · ASR/TTS 管道 · SQLite · 系统通知              │
└──────────────────────────────────────────────────────────┘
```

### 三种运行形态

| 形态 | 宿主 | 说明 |
|---|---|---|
| ① 独立 App | Tauri v2 桌面壳 | 默认形态。任何 harness 通过本地 API / MCP / hooks 接入 |
| ② overlay 插件 | harness web 视口 | 如 dsh 插件：同页运行，共享会话事件，走页内服务注册 |
| ③ core 库 | 任意 npm 宿主 | `@maneki-pet/core` + 自选渲染，被第三方集成 |

三形态共享 core 与网关，只是 Shell 与生命周期不同（借鉴 dsh-pet 的三形态设计并推广到任意 harness）。

## 3. Pet Shell 渲染层

### 3.1 动画系统

- **载体**：动作包（Pack）。两种素材类型：
  - `video-alpha`：透明视频（VP9-alpha webm + HEVC-alpha mov 双格式兜底，兼容 Safari/WKWebView）
  - `spritesheet`：精灵图序列帧（轻量、低内存，适合简单包）
- **播放模型**：带权重的无缝动画链（idle 呼吸 → 漫游 → 玩耍 → ……），由 `PetState` + 权重 + 打断规则驱动（借鉴 dsh-pet）。
- **交互物理**：点击 Q 弹、拖拽、甩抛（纯 TS 实现，放 core 以便三形态复用）。

### 3.2 动作包格式（草案）

```
pack.json
{
  "id": "xiaozhao-default",
  "name": "小招 · 招财猫",
  "version": "1.0.0",
  "renderer": "video-alpha",            // 或 "spritesheet"
  "permissions": [],                     // 见 §7.5
  "states": {
    "idle":    { "clips": ["breathe", "tail-wave"], "weights": [0.7, 0.3] },
    "thinking":{ "clips": ["paw-chin"] },
    "working": { "clips": ["typing"] },
    "waiting_input": { "clips": ["beckon"] },   // 招手！
    "celebrating": { "clips": ["dance", "sparkle"] },
    "error":   { "clips": ["droop"] },
    "sleeping":{ "clips": ["zzz"] }
  },
  "actions": [ { "id": "play-ball", "clips": [...], "trigger": "interaction|skill|event" } ]
}
assets/  (webm + mov / png 序列帧)
```

- 状态集合与 `Assistant Core` 的 `PetState` 枚举对齐；缺省状态回退到 `idle`。
- 校验：manifest schema + 素材哈希清单，安装时验签（见 §7.5）。

### 3.3 素材管线（可复现，借鉴 dsh-pet 配方思路）

`提示词配方 → AI 生成绿幕视频 → 抠像 → 透明视频转码（webm/mov）→ 打包`

管线以脚本 + 配方文件形式随仓库提供，任何人可复现或二创自己的宠物。

### 3.4 桌面壳选型：Tauri v2 优先

| 选项 | 内存基线 | 透明视频 | 结论 |
|---|---|---|---|
| Tauri v2（系统 WebView） | ~60–120MB | Win WebView2 ✅ webm-alpha；macOS WKWebView 用 mov 兜底；Linux webkitgtk 验证 | ✅ 首选，M1 做 spike 验证 |
| Electron | ~150–300MB | ✅ Chromium | 备选，若 Tauri 透明窗/编解码坑过深则切换 |

性能要求（§8）以 Tauri 为基准制定；若切换 Electron，预算目标同步上调并在本文修订。

## 4. Assistant Core 助理核心

纯 TS 库（`packages/core`），无 UI / 无 IO 依赖（IO 经接口注入），可单测。

### 4.1 Persona & Dialogue

- LLM 对话：人设 prompt + 会话记忆窗口；LLM Provider 可插拔（OpenAI 兼容接口优先，兼容 DeepSeek/GLM/Qwen 等本地或云服务）。
- 输出通道：气泡文字（必需）+ TTS 语音（可选）。

### 4.2 PetState 状态机

```
idle → thinking → working → waiting_input → working → celebrating / error
idle → sleeping（时段自动 / 手动）
任意 → celebrating（任务交付、提醒命中）
```

状态由事件驱动（harness 事件、定时器、用户交互），映射到动作包的 `states`。

### 4.3 Proactivity Engine 主动性引擎

主动行为 = `触发器(trigger) × 预算(budget) × 通道(channel)`：

| 触发器 | 例子 |
|---|---|
| 定时 | 到点提醒、番茄钟、久坐提醒 |
| harness 事件 | 任务完成、等待输入超时、连续报错 |
| 存在感知 | 用户回座（输入恢复）、长时间空闲 |
| 上下文 | 节日问候、待办堆积、会话总结 |

- **防打扰预算**：静音时段、每小时主动次数上限、优先级分级（高优先级穿透，如"任务需要你确认"）。
- 主动行为也走 LLM 人设生成话术，但触发与预算是确定性规则，不交给 LLM 自由发挥。

### 4.4 Memory & Reminders

- SQLite（`reminders` / `memories` / `tasks` / `conversations` 表）。
- 记事流：用户语音/文字「帮我记一下 X 点做 Y」→ 意图解析（本地规则优先，复杂交 LLM）→ 落库 → 到点经 气泡+TTS+系统通知 送达 → 未确认则按升级策略重提。
- 会话记忆：分层（短期窗口 / 长期摘要），全部本地。

### 4.5 Skill System 技能插件

- 技能 = 声明权限清单的 TS 包，注册为：对话工具（LLM function call）、主动性触发器、命令面板动作。
- 与动作包解耦：技能可调用 `pet.play(action)` / `pet.say(text)` 表达自己。

## 5. Harness Gateway 适配网关

核心创新点：**一套契约 + 双通道（Adapter / MCP）**，让"易接入各种 harness"成立。

### 5.1 Harness Adapter Contract（TS 草案）

```ts
interface HarnessAdapter {
  id: string;                          // "dsh" | "claude-code" | "pi" | ...
  capabilities: {
    events: boolean;                   // 能否推送会话事件
    submit: boolean;                   // 能否派发任务
    cancel: boolean;
  };

  /** 发现本机运行中的 harness 会话/项目 */
  discover(): Promise<HarnessSession[]>;

  /** 宠物 → harness：派发任务 */
  submit(req: TaskRequest): Promise<TaskRef>;

  /** harness → 宠物：事件流 */
  onEvent(cb: (e: HarnessEvent) => void): Unsubscribe;

  cancel(ref: TaskRef): Promise<void>;
}

interface TaskRequest {
  prompt: string;
  workdir?: string;
  harness?: string;                    // 缺省用默认适配器
  confirmPolicy: "auto" | "ask" | "deny";   // 破坏性操作策略，默认 ask
  timeoutMs?: number;
  notify: ("bubble" | "tts" | "system")[];  // 完成通知通道
}

type HarnessEvent =
  | { type: "task.started";   taskId: string; summary?: string }
  | { type: "task.progress";  taskId: string; summary?: string }
  | { type: "task.needs_input"; taskId: string; question: string }
  | { type: "task.completed"; taskId: string; summary?: string; artifacts?: string[] }
  | { type: "task.error";     taskId: string; message: string }
  | { type: "session.idle" }
  | { type: "session.busy";   state: "thinking" | "working" | "waiting" };
```

### 5.2 事件 → 宠物反应

| 事件 | PetState | 主动行为 |
|---|---|---|
| task.started / progress | working | 头顶气泡显示进度摘要 |
| session.busy(thinking) | thinking | — |
| task.needs_input | waiting_input | **高优先级**招手 + 系统通知，点击跳回 |
| task.completed | celebrating | 交付播报（气泡+可选TTS），产物路径直达 |
| task.error | error | 报错摘要，提供"让 Agent 重试/看看日志"快捷技能 |
| session.idle 超时 | sleeping | — |

### 5.3 Task Broker 流程（用户 → harness → 用户）

```
用户（语音/文字/命令面板）
  → 意图解析：闲聊 / 记事 / 提醒 / 派发任务
  → [派发任务] confirmPolicy 检查（ask → 宠物 UI 确认）
  → Adapter.submit() → taskId
  → 事件总线跟踪（动画/进度）
  → completed/error → 主动通知 + 产物交付（路径/摘要）
```

### 5.4 MCP 模式（零适配器接入）

Maneki 内置 MCP Server，向宿主 harness 暴露工具，任何 MCP 宿主（Claude Code、ZCode、…）无需写适配器即可驱动宠物：

| MCP 工具 | 作用 |
|---|---|
| `maneki_say(text, mood?)` | 宠物说话（气泡+可选语音） |
| `maneki_set_state(state)` | 切换宠物状态动画 |
| `maneki_play(action)` | 播放指定动作 |
| `maneki_notify(title, body, urgency)` | 系统通知（Agent 完成/需确认） |
| `maneki_remind(when, message)` | Agent 帮用户记提醒 |

反向（宠物 → harness）仍需 Adapter；MCP 覆盖"harness 主动汇报"这一高频方向。

### 5.5 各 harness 接入策略

| harness | 事件方向 | 派发方向 | 落地形式 |
|---|---|---|---|
| dsh | 插件页内服务（同 dsh-pet 模式） | 插件 API | 形态② overlay 插件 |
| Claude Code | hooks（Notification/Stop/PreToolUse…） | CLI (`claude -p`) | 形态① + hooks 配置 |
| ZCode | MCP（`maneki_*` 工具） | 待评估 | 形态① + MCP |
| pi / 其他 | MCP 或 CLI 适配 | CLI 包装 | generic-cli 适配器模板 |

generic-cli 适配器：`命令模板 + 输出解析`，覆盖"有 CLI 就能接"的长尾。

## 6. Local Services 本地服务

- **HTTP/WS API**：仅 `127.0.0.1`，路径前缀 + 安装期随机 token 鉴权；附 OpenAPI 3.1 文档（借鉴 dsh-pet 开放 API 思路）。WS 用于事件推送到 Shell/插件。
- **语音管道**：ASR = whisper.cpp 本地 / 云端接口可配；TTS 同理；VAD 按键说话优先，唤醒词（openWakeWord 等）作为可选技能。
- **存储**：SQLite 单文件，放用户数据目录；含 reminders / memories / tasks / conversations / packs 表。
- **系统通知**：通知点击可携带路由（如跳回 harness 会话）。

## 7. 安全模型

| # | 威胁 | 对策 |
|---|---|---|
| 7.1 | 局域网内其他进程调用宠物 API | 仅绑 127.0.0.1；随机 token；CORS 白名单；来源进程可选校验 |
| 7.2 | 恶意网页/插件驱动宠物执行命令 | 宠物 API 只表达（说话/动画/通知/提醒）；执行类能力仅经 Adapter 且受 confirmPolicy 约束 |
| 7.3 | 提示注入：Agent 输出中夹带"请执行 rm -rf" | Agent 输出一律按**数据**渲染；动作意图只能来自结构化工具调用 + 用户确认；高危命令模式清单硬拦截 |
| 7.4 | 破坏性操作 | confirmPolicy 默认 ask；危险命令（删除/推送/付费 API）强制 ask 且展示完整命令 |
| 7.5 | 恶意动作包/技能 | 权限清单 + 素材哈希验签 + 只从声明的源安装；技能跑在受限 API 面后 |
| 7.6 | 隐私泄露 | 记忆/语音/任务本地存储；云端 LLM/ASR/TTS 显式配置且设置页可一键全关；日志默认脱敏 |
| 7.7 | 会话串扰 | TaskBroker 维护 workdir 约束，任务与产物路径绑定，不跨项目误派 |

## 8. 性能预算与策略

| 指标 | 目标 |
|---|---|
| 空闲常驻内存（壳+core+存储） | < 150MB |
| harness 事件 → 宠物动画切换延迟 | < 300ms |
| 动画播放丢帧 | 透明视频解码直渲，无合成层抖动；低配机降级 spritesheet |
| 语音按键 → ASR 返回（本地小模型） | < 1.5s |
| 主动提醒命中 → 通知送达 | < 1s |

策略：core 纯 TS、事件驱动、无轮询（除 presence 降级）；动画资产预解码 LRU；WS 单连接复用。

## 9. 技术选型与取舍

| 决策 | 选择 | 取舍 |
|---|---|---|
| 语言 | TypeScript（monorepo, pnpm） | 桌宠生态（dsh 插件、MCP SDK、web 渲染）全在 TS；用户学习曲线友好 |
| 桌面壳 | Tauri v2 优先，Electron 备选 | 性能 vs 生态成熟度；M1 spike 定案（透明视频跨三平台兼容性是主要风险） |
| 动画载体 | 透明视频为主 + spritesheet 兜底 | 表现力 vs 内存；双格式素材兜底 Safari/WKWebView |
| 存储 | SQLite | 单文件、可靠、零运维 |
| MCP | @modelcontextprotocol/sdk | 零适配器接入的最大杠杆 |
| 语音 | whisper.cpp + 可插拔云端 | 隐私默认本地，质量可选云端 |

## 10. 开放问题

1. Tauri v2 透明视频在 macOS WKWebView 的 mov-HEVC 兜底实际效果（M1 spike 验证）。
2. dsh 插件 API 的稳定版本对齐策略（跟随 dsh-pet 的做法还是抽象隔离）。
3. 语音主动播报的礼貌等级模型（如何避免变成噪音）——M3 用真实使用数据调。
4. 多 harness 并发任务的仲裁与展示（多任务时宠物动画如何表达）——M5 前定案。
