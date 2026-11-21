# Maneki · 小招

一只陪你工作、替你留意 dsh 会话的桌宠。两个项目同时运行时，你可以直接问「哪个会话在等我？」。小招会根据宿主事件回答，工程操作和审批仍留在 dsh。关掉桌宠窗口后，后台继续照看提醒。

[Windows 安装指南](./docs/install-windows.md) · [dsh 插件](./apps/dsh-plugin/README.md) · [架构设计](./docs/architecture.md) · [路线图与验收](./docs/roadmap.md) · [MIT](./LICENSE) · [提醒改期验收](./docs/audits/2026-11-21-agent-reminder-reschedule.md)

## 现在能用什么

| 场景 | 能力与验收边界 |
| --- | --- |
| 聊天、待办与单次提醒 | Windows x64 个人预览 `0.2.0-alpha.2`。模型关闭也能处理「半小时后提醒我休息」等明确指令。阶段一另以 Windows 独立身份确认跨项目续聊，两个 dsh 均退出后，用户看到了该次 Windows 提醒。[安装与使用](./docs/install-windows.md) · [阶段一实机记录](./docs/audits/2026-11-13-stage1-dsh-companion.md) |
| 找到等待回应的会话 | 当前源码支持按项目目录名、会话 ID 和阶段查看进度。真实 dsh 的等待、完成、续接、取消和失联均有对照记录。[会话验收](./docs/audits/2026-11-14-session-observations.md) |
| 按住说话与朗读 | 麦克风、识别和合成分别启用。可选本地引擎、百炼，或单独授权 dsh 提供只读进度查询所需的转写。真实录音与第二个会话同时完成的组合场景仍待验收。[语音配置](./docs/voice.md) |
| 形象、动作与轻陪伴 | 源码支持动作包、点播、模板气泡、「来一句」及暂停。自动台词遵守勿扰和独立预算。正式素材另行准备；长时间节奏、真实休眠及多屏观感待验。[轻陪伴验证](./docs/audits/2026-11-14-template-companionship.md) |
| 长期记忆 | EverNook 的保存与召回分别授权，记忆有来源，tokenizer 在本地匹配模型。已做隔离身份联验，跨天自然问句的产品体验仍在验收。[配置与证据](./packages/adapters/evernook/README.md) |
| 让 personal agent 安排休息 | 对已授权的 agent 说「半小时后提醒我休息」。小招保存一次提醒，宿主退出后，仍由后台到点投递。[配对与重试示例](#agent-reminders) |
| 让 personal agent 管理自己安排的提醒 | 权限分别授予。agent 可查询尚未开始投递的提醒，并精确取消或改期其中一条。[查询与取消](#agent-reminder-management) · [改期](#agent-reminder-reschedule) |
| 让 personal agent 整理开工简报 | 单独授权后，agent 可通过 SDK、HTTP、CLI 或 MCP 一次查询到期待办和等待回应的 dsh 会话。[接入示例](#让-personal-agent-帮你开工) |

安装包是封存的本地预览。下文的 SDK、CLI 与独立 MCP 桥使用同一版 `main` 源码构建。Windows x64 是本轮验证平台，macOS/Linux 仍是目标平台。

## 架构

```mermaid
flowchart TB
    Shell["桌宠与个人助手面板"] -->|HTTP / WebSocket| Runtime["共享 Runtime<br/>身份、权限、生命周期"]
    Dsh["dsh 插件"] -->|状态租约与会话观察| Runtime
    Agent["外部 Agent"] -->|stdio| MCP["独立 MCP 桥<br/>表现状态 / 开工简报 / 提醒"]
    CLI["命令行"] --> SDK["Node SDK"]
    MCP --> SDK
    SDK -->|本机 HTTP| Runtime
    Runtime --> Core["Core<br/>状态仲裁、预算、领域规则"]
    Runtime --> Store[("SQLite<br/>会话、个人事项、审计")]
    Runtime --> Ports["对话、语音与记忆适配器"]
    Ports --> Local["本地模型 / 操作系统语音 / EverNook"]
    Ports --> Cloud["用户启用的云端服务"]
```

多个 Shell 共享一个 Runtime 和一个数据库拥有者。Core 定义规则与端口，Runtime 负责 IO 与装配。表情租约表达的是某个来源当前想展示的状态；个人会话的任务进度另有来源、序列和时效。personal agent 可将自己的工作进度显示在桌宠上。简报查询与提醒创建、查询、取消、改期分别授权。要接入可执行任务，仍须单独实现并验收 Adapter 的审批、取消和恢复。[模块分工与接口](./docs/architecture.md)

## 接入小招

| 入口 | 适用场景 | 当前边界 |
| --- | --- | --- |
| dsh 插件 | 人类在宿主输入 `/maneki pair`、`show`、`assistant` | 首个宿主，观察已收到的会话事件；配对与退出经原生管理入口 |
| 本机 API / WebSocket | 非 Node 客户端、原生桌面或订阅实时事件 | HTTP v1 固定回环、按 scope 鉴权；WS 使用一次性短期票据。[本地接口](./docs/architecture.md#61-runtime-应用接口) |
| Node SDK | 在 Node agent 中显示进度、查询简报或管理自己的提醒 | 源码 workspace 包 `@maneki-pet/sdk`，提供 `getState()`、`setState()`、`getBriefing()`、`createReminder()`、`listReminders()`、`cancelReminder()`、`rescheduleReminder()`。[SDK 源码](./packages/sdk/src/index.ts) |
| CLI | 脚本管理提醒、查询简报、读取或更新表现状态 | `remind`、`reminders`、`cancel-reminder`、`reschedule-reminder`、`briefing`、`state get`、`state set`；已有平台草稿、导出和离线诊断命令继续可用 |
| MCP stdio | 支持 MCP 的外部宿主连接已运行的小招 | 状态桥提供 `maneki_set_state`，简报桥提供 `maneki_get_briefing`，提醒桥分别提供 `maneki_remind`、`maneki_list_reminders`、`maneki_cancel_reminder`、`maneki_reschedule_reminder`。每个桥使用自己的凭证。[MCP 契约](./docs/architecture.md#55-mcp-与各-harness-的接入策略) |

**从源码试用。** Windows 构建使用 Node 24.12.0 x64、Corepack、Rust 1.88+、MSVC 和 PATH 中的 FFmpeg、ffprobe。干净检出会生成开发占位形象。正式角色包的导入、许可证与构建配方另见[角色素材说明](./apps/desktop/recipes/catgirl-signature-v2.md)。

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm -r build
corepack pnpm -r test
```

以下示例使用单独的数据目录。先在仓库根目录的一个终端启动后台，保持终端打开。

```powershell
$demoDir = Join-Path $env:LOCALAPPDATA 'ManekiIntegrationDemo'
node packages/runtime/dist/cli.js --config-dir "$demoDir" --port 18101 --background
```

在第二个终端为该调用方配对。配对脚本验证正在运行的实例，只输出该客户端的 JSON 凭证文件路径。每次调用都在发送凭证前核验同一连接上的 Runtime 身份。缺少身份证明的旧 Runtime 需要与客户端一起升级。同一名称可复用已配对的身份。每个接入方使用独立名称，凭证文件留在当前用户的私有目录。

```powershell
$demoDir = Join-Path $env:LOCALAPPDATA 'ManekiIntegrationDemo'
$env:MANEKI_RUNTIME_URL = 'http://127.0.0.1:18101'
$env:MANEKI_TOKEN_FILE = node packages/runtime/scripts/pair-expression-client.mjs "$demoDir" 18101 my-agent
$sourceId = [guid]::NewGuid().ToString()
node packages/cli/dist/main.js state set working --source-id $sourceId
node packages/cli/dist/main.js state get
node packages/cli/dist/main.js state set idle --source-id $sourceId
```

状态租约持续 15 秒。长任务用同一个来源续租，结束时发送 `idle`。返回值为所有来源仲裁后的当前状态。例中的后台独立于已有安装；要让桌宠显示这些状态，桌面与客户端须连接同一个 Runtime。

同一个 agent 改用 SDK 时，可在依赖 `@maneki-pet/sdk` 的 workspace 包中使用它自己的凭证。另一个 agent 应以新名称配对，这样可以单独撤销。可写入 `idle`、`thinking`、`working`、`waiting_input`、`celebrating`、`error`。

```js
import { createExpressionClient } from "@maneki-pet/sdk";

const pet = createExpressionClient({
  baseUrl: process.env.MANEKI_RUNTIME_URL,
  tokenFile: process.env.MANEKI_TOKEN_FILE,
});
await pet.setState("thinking");
console.log(await pet.getState());
await pet.setState("idle");
```

MCP 宿主将 `command` 设为 `node`，`args` 填入 `packages/cli/dist/state-mcp.js` 的**绝对路径**，独立宿主先用另一个名称（例如 `my-mcp-host`）配对，再为宿主配置同一 `MANEKI_RUNTIME_URL` 和它自己的 `MANEKI_TOKEN_FILE`。工具 `maneki_set_state` 接收如 `{"state":"working"}` 的参数。桥关闭后，原有后台与其他来源继续运行。

## 让 personal agent 帮你开工

问「今天有什么该处理？哪个 dsh 会话在等我？」时，agent 可以一次读取两份已有记录：按小招设置的时区，列出到今天为止仍未完成的待办；按最近观测时间，列出在线来源中正在等你输入的会话。每类最多 8 条。返回的 `moreTodos`、`partialSessions` 标明省略情况，`onlineSources`、`offlineSources` 区分“没人等”和“宿主已失联”。在 dsh 中确认并处理实际工作。

| personal agent 想做的事 | 本版的调用边界 |
| --- | --- |
| 查看今天到期和已经逾期的待办 | 简报返回标题与截止日；备注、未来事项、无截止日事项以及已完成项留在助手内 |
| 找到等待回应的 dsh 会话 | 简报返回项目目录名、会话 ID、观测时间及来源标识。项目名和标题均按数据处理 |
| 安排一次提醒 | 另外授权创建提醒后可调用 `maneki_remind`。查询、取消和改期自己的提醒分别授权。管理待办使用个人助手面板 |
| 调模型、用麦克风、读长期记忆或执行工程任务 | 各有单独的入口与授权；工程派发仍受原生审批和恢复验收限制 |

**授权一次，查询多次。** 以下沿用上面已启动的示例 Runtime。该权限覆盖所有项目。配对前请核对实际调用方及它使用的模型：如果 agent 接入云端，返回的标题和项目名可能随其上下文发往该服务。每个 agent 使用独立名称，同名重复配对复用既有身份。

```powershell
node packages/runtime/scripts/pair-briefing-client.mjs --help
$env:MANEKI_BRIEFING_TOKEN_FILE = node packages/runtime/scripts/pair-briefing-client.mjs "$demoDir" 18101 personal-agent --allow-briefing-read
node packages/cli/dist/main.js briefing
```

在 `@maneki-pet/sdk` 的 workspace 调用方读取同一份结构化结果：

```js
import { createBriefingClient } from "@maneki-pet/sdk";

const agent = createBriefingClient({
  baseUrl: process.env.MANEKI_RUNTIME_URL,
  tokenFile: process.env.MANEKI_BRIEFING_TOKEN_FILE,
});
const { date, todos, waiting, offlineSources } = await agent.getBriefing();
```

本机 HTTP 接口为 `GET /v1/briefing`，使用 `briefing_read`。SDK 先验证 Runtime 身份，再在同一连接发送凭证；旧 Runtime 缺少该证明时需升级。MCP 宿主使用 Node 启动 `packages/cli/dist/briefing-mcp.js` 的绝对路径，并传入 `MANEKI_RUNTIME_URL` 及该宿主自己的 `MANEKI_BRIEFING_TOKEN_FILE`。它只公布无参工具 `maneki_get_briefing`。dsh 的观察插件负责上报会话，简报 MCP 客户端单独配置。[HTTP 身份校验协议](./docs/architecture.md#work-briefing) · [dsh 配置与命令](./apps/dsh-plugin/README.md#让-dsh-读取开工简报)

随时可用下列命令撤销该 agent 的访问。已连接的 MCP 桥下一次读取也会被拒绝。撤销按 Runtime 登记的调用方名称办理，即使凭证文件已经丢失也能生效。之后如需重新授权，请显式选用新名称。

```powershell
node packages/runtime/scripts/pair-briefing-client.mjs "$demoDir" 18101 personal-agent --revoke-briefing-read
```

<a id="agent-reminders"></a>

## 让 personal agent 到点提醒你

对已配置提醒工具的 dsh 说「半小时后提醒我休息」。agent 将这条意图转换成 1800 秒和正文「休息」，小招以首次成功受理的时间为起点，保存后返回提醒 ID 和到期时间。关闭 dsh 后请让 Runtime 继续运行。勿扰期间到期的提醒按现有调度规则延后投递。[dsh 配置示例](./apps/dsh-plugin/reminder.patch.example.yml) · [创建与 Windows 投递验收](./docs/audits/2026-11-21-agent-reminders.md)

在上文启动示例 Runtime 的第二个 PowerShell 终端中，**为实际调用方单独授权**。该权限允许这个 agent 安排多条一次性提醒，正文会出现在本机通知上。

```powershell
$env:MANEKI_REMINDER_TOKEN_FILE = node packages/runtime/scripts/pair-reminder-client.mjs "$demoDir" 18101 personal-agent --allow-reminder-create
if ($LASTEXITCODE -ne 0) { throw '提醒配对失败' }
$requestId = [guid]::NewGuid().ToString()
node packages/cli/dist/main.js remind --request-id $requestId --after-seconds 1800 --message '休息'
```

**同一条用户意图保留同一个请求 ID。** 如果没收到响应，使用原凭证、原 ID、原延时和正文重试，即使 Runtime 已重启也会返回首次创建回执。改用新 ID 会创建另一条提醒；用同一个 ID 更换参数会收到 HTTP 409。即使用户后来取消了提醒，重试也不会恢复它。不同 agent 的请求 ID 互相独立。

| 接入方式 | 调用 |
| --- | --- |
| Node SDK | `createReminderClient({ baseUrl, tokenFile }).createReminder({ requestId, afterSeconds: 1800, message: "休息" })`，客户端从 `@maneki-pet/sdk` 导入 |
| 本机 HTTP | 完成提醒身份校验后，向 `POST /v1/reminders` 发送相同三个字段。[握手与回执协议](./docs/architecture.md#agent-reminders) |
| MCP stdio | 用 Node 启动 `packages/cli/dist/reminder-mcp.js` 的绝对路径，传入 `MANEKI_RUNTIME_URL` 及专用的 `MANEKI_REMINDER_TOKEN_FILE`。唯一工具为 `maneki_remind` |

每个已授权身份在每个 UTC 整点小时最多新建 30 条。重复读取原创建回执不占配额。创建回执里的 `remindAt` 是到期时间（Unix 毫秒）；系统受理通知和用户确认已看见分别记录。要停止 agent 继续创建，运行以下命令。已经安排的提醒会保留，可从个人助手面板管理。

```powershell
node packages/runtime/scripts/pair-reminder-client.mjs "$demoDir" 18101 personal-agent --revoke-reminder-create
```

<a id="agent-reminder-management"></a>

## 让 personal agent 查询和取消提醒

对已授权的 dsh 说「帮我看看还有哪些提醒，把刚才那个休息提醒取消掉」。agent 先查询自己安排且尚未开始投递的提醒，再用上次创建回执中的 ID 确认「刚才那个」，并带上列表中的版本取消。若只知道标题且有多条同名记录，请先让用户确认具体时间和条目。小招按 ID 和版本处理每次取消。[dsh 查询与取消配置](./apps/dsh-plugin/README.md#让-dsh-查询和取消自己安排的提醒)

先为实际调用方配对创建权限，再用**同一登记名**分别授权查询和取消。查询权限可读取该身份所建提醒的正文和时间。由 agent 使用的模型也可能收到这些字段。其他 agent 和桌面创建的提醒可在小招个人助手面板管理。以下沿用上文的演示 Runtime、端口和名称。

```powershell
$env:MANEKI_REMINDER_READ_TOKEN_FILE = node packages/runtime/scripts/pair-reminder-read-client.mjs "$demoDir" 18101 personal-agent --allow-reminder-read
if ($LASTEXITCODE -ne 0) { throw '查询提醒配对失败' }
$env:MANEKI_REMINDER_CANCEL_TOKEN_FILE = node packages/runtime/scripts/pair-reminder-cancel-client.mjs "$demoDir" 18101 personal-agent --allow-reminder-cancel
if ($LASTEXITCODE -ne 0) { throw '取消提醒配对失败' }
node packages/cli/dist/main.js reminders
```

从列表确认 `reminderId` 和 `version` 后，为这次取消生成一个新的 `requestId`。如响应丢失，原样保留这三个值重试。相同请求会返回首次回执。成功后，拿同一个请求 ID 改取消另一条会被拒绝。若版本变化或投递已开始，读取最新状态并向用户说明。

| 入口 | 查询 | 取消 |
| --- | --- | --- |
| SDK | `createReminderReadClient(...).listReminders()` | `createReminderCancelClient(...).cancelReminder({ requestId, reminderId, version })` |
| HTTP | `GET /v1/reminders/pending` | `POST /v1/reminders/cancel`，提交三个取消字段 |
| CLI | `maneki reminders` | `maneki cancel-reminder --request-id <id> --reminder-id <uuid> --version <n>` |
| MCP stdio | `reminder-read-mcp.js` 提供 `maneki_list_reminders` | `reminder-cancel-mcp.js` 提供 `maneki_cancel_reminder` |

分别用相应配对脚本的 `--revoke-reminder-read` 和 `--revoke-reminder-cancel` 撤销权限。撤销对已连接的桥的下一次调用也生效。[身份校验及响应格式](./docs/architecture.md#agent-reminder-management) · [查询与取消验收](./docs/audits/2026-11-21-agent-reminder-management.md)

<a id="agent-reminder-reschedule"></a>

## 让 personal agent 改期一条提醒

对已配置查询和改期工具的 dsh 说「把刚才那个休息提醒改到一小时后」。agent 用原创建回执的 ID 和当前列表的版本锁定目标。出现无法区分的同名记录时，先确认具体时间和条目。小招把同一条提醒的到期时间更新为首次受理时刻加 3600 秒，保留原 ID 和正文。只有新的到期安排进入调度。[dsh 使用指南](./apps/dsh-plugin/README.md#让-dsh-改期自己安排的提醒) · [改期验收](./docs/audits/2026-11-21-agent-reminder-reschedule.md)

用与创建提醒相同的登记名，单独授权 `reminder_reschedule`。它只能修改该身份自己安排且从未开始投递的提醒时间。以下示例沿用上文的 Runtime、端口和名称。从查询结果填入实际 UUID 和版本。

```powershell
$env:MANEKI_REMINDER_RESCHEDULE_TOKEN_FILE = node packages/runtime/scripts/pair-reminder-reschedule-client.mjs "$demoDir" 18101 personal-agent --allow-reminder-reschedule
if ($LASTEXITCODE -ne 0) { throw '提醒改期配对失败' }
node packages/cli/dist/main.js reminders
```

| 入口 | 调用 |
| --- | --- |
| SDK | `createReminderRescheduleClient(...).rescheduleReminder({ requestId, reminderId, version, afterSeconds: 3600 })` |
| 本机 HTTP | `POST /v1/reminders/reschedule`，提交同样四个字段 |
| CLI | `maneki reschedule-reminder --request-id <id> --reminder-id <uuid> --version <n> --after-seconds 3600` |
| MCP stdio | 用 Node 启动 `reminder-reschedule-mcp.js`，传入 `MANEKI_RUNTIME_URL` 和专用 `MANEKI_REMINDER_RESCHEDULE_TOKEN_FILE`。工具为 `maneki_reschedule_reminder`。 |

回执包含到期 Unix 毫秒 `remindAt` 和新 `version`。响应丢失时，原样重试四个字段，包括原版本。重试取回同一份回执，不会从重试时间重新算一小时。版本变更或投递开始会拒绝新的改期请求。每个改期身份每 UTC 整点小时可成功改期 30 次，重试取回回执不占次。撤销时使用相同配对脚本和 `--revoke-reminder-reschedule`；已安排的新时间保留。[请求、回执与握手](./docs/architecture.md#agent-reminder-reschedule)

## 模型与数据

- **对话**使用显式配置的 Chat Completions 兼容端点。本地服务使用回环地址，云端服务需要 HTTPS 和单独授权。更换模型服务的协议、主机或端口后，需为新服务重新配置密钥。
- **语音**独立选择 ASR 和 TTS。录音默认仅在内存处理，关闭麦克风仍可使用文字和提醒。云端语音使用独立密钥。[语音配置与设备验收](./docs/voice.md)
- **主动陪伴**由确定性规则决定是否打扰。模板可离线工作；外部工具和模型输出作为数据处理，个人事项的修改必须经过相应入口的授权与校验。[轻陪伴协议](./docs/architecture.md#light-companionship)
- **性能目标**为空闲全相关进程树私有内存 ≤ 300 MiB，其中 Runtime ≤ 75 MiB；事件到动画首帧 p95 < 300 ms，已运行状态下提醒到通知调用 p95 < 1 s。不同设备、模型及素材分别测量。[性能预算与验收口径](./docs/architecture.md#8-性能可维护性与验证)

## 设计参考与许可

AIRI 将展示端、共享模块、服务通道与外部集成分别画在架构图上。Maneki 借鉴这一点，让宿主和桌宠共用一个状态入口。Open-LLM-VTuber 分别配置语言模型、识别与合成；小招沿用独立 Provider 的思路，并为云端数据传输单独授权。[AIRI](https://github.com/moeru-ai/airi/tree/e2e19ca972a789fa5ebf2edb9622eca855c340c7) · [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/tree/992309c0aa19845960228f880013d4685fde93b5) · [早期桌宠项目调研与致谢](./docs/research.md)

代码采用 [MIT 许可证](./LICENSE)。角色、第三方组件和模型各自适用随附许可。问题、复现步骤和接入体验可提交到 [GitHub Issues](https://github.com/destinyTaoTao/maneki-pet/issues)。
