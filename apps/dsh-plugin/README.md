# dsh 基础插件（Windows）

源码版在原有连接、配对和助手入口之外，增加可选的 dsh 本地语音识别接入。命令通过 dsh `0.2.1-rc.5` 的人类命令注册表处理，不发送给模型；状态观察仍只取得 `express` 凭证，语音宿主须另经原生确认并取得独立 `speech_host` 凭证，不读取 root 或个人助理凭证。封存的 `0.3.0` 发行包不含此源码增量。

## 安装与配对

Windows x64 `0.2.0-alpha.2` 预览安装器内置 Runtime 和 Node，并在安装完成登记入口；无需从源码构建。使用随包 `0.3.0` tgz 接入 dsh，完整步骤见[安装说明](../../docs/install-windows.md)。下方源码构建方式仍可用于开发。

桌面与 Runtime 须使用本轮一起构建的版本。安装布局包含相邻的 `maneki-desktop.exe`、`maneki-runtime.exe` 与 `resources/maneki-runtime-bundle.js`；只替换壳或使用旧安装版不支持管理协议。先运行更新后的桌面一次，或执行已安装的 `maneki-desktop.exe --assistant register`，将固定入口登记到 `%APPDATA%/com.manekipet.desktop/installation.json`。插件不会下载、安装或运行项目配置给出的命令。

从本仓库构建并打包（产物不发布到 npm）：

```powershell
pnpm -r build
pnpm --filter @maneki-pet/dsh-plugin pack --pack-destination C:/maneki-lab
dsh plugin --profile web add C:/maneki-lab/maneki-pet-dsh-plugin-0.3.0.tgz
```

重启 `dsh web`，然后在 dsh 输入 `/maneki pair`，检查原生确认框中的 profile 与权限后手动同意。首次连接只会启动已安装 Runtime 并提示配对，不自动授权；已配对时后续启动可复用凭证。撤销或损坏凭证不会静默重配，须由受信管理入口核查并显式移除对应的 `runtime/dsh-client-<profileId>.json` 后再配对。

| 命令 | 行为 |
|---|---|
| `/maneki status` | 核验本机服务身份并查询后台状态，不启动服务 |
| `/maneki connect` | 启动或连接同一 Runtime，复用已授权凭证 |
| `/maneki pair` | 原生确认后，为当前 profile 单独授予状态表达权限 |
| `/maneki speech-pair` | 原生确认后，单独授权本实例提供本地语音识别 |
| `/maneki speech-connect` | 复用已授权的语音凭证；不会自动重新配对 |
| `/maneki show` | 启动或显示同一只桌宠，不重复创建窗口 |
| `/maneki assistant` | 打开同一桌面窗口中的对话、按键语音、个人待办、提醒和全局设置面板；不把个人凭证交给 dsh |
| `/maneki quit` | 原生确认后停止助理后台并关闭桌宠；不取消外部 dsh 任务 |

本地 profile 的 `cordis.patch.yml` 可覆盖接入选项：

```yaml
- id: maneki-observer
  config:
    profileId: web
    showOnConnect: true
```

其他 profile 请配置不同的 `profileId`（1–64 位字母、数字、下划线或连字符，Windows 不区分大小写），以分别配对和撤销；助手 Runtime 与数据库仍共享。相同 ID 视为同一个接入客户端。`showOnConnect` 默认开启，只在连接成功后请求显示。不同项目不要覆盖个人助手的隐私、语音或勿扰偏好。当前全局设置通过 `/maneki assistant` 打开；尚未嵌入 dsh 设置页面。

关闭 dsh、卸载插件或托盘“关闭桌宠（后台继续）”只断开视图，Runtime 保留；明确“退出助理”才停止后台。当前插件执行 quit 后不会自行再启动，需显式 connect/show；宿主重新启动/插件重新启用会按上述启动配置连接。缺安装、身份不符、配对失败等情况明确降级，dsh 继续运行。

基础入口验证见[记录](../../docs/audits/2026-11-07-dsh-plugin-management.md)；2026-11-08 已补同模板独立身份的真实 NSIS 安装、覆盖升级、卸载保留数据及实际 dsh 加载，见[交付记录](../../docs/audits/2026-11-08-windows-preview-delivery.md)。原生同意/拒绝及托盘退出点击仍待用户验收；不以底层管理 API 的通过替代。生产身份的既有用户迁移与 macOS/Linux 未验收。

## 状态观察与兼容入口

2026-11-14 源码增量（#65）：插件在原有聚合表情之外，上报当前实例观察到的逐会话记录，包括 profile、项目目录名、完整会话 ID、阶段与观测时间。工程正文、完整路径、工具参数仍留在 dsh。小招“会话”页和主会话规则查询读取相同记录；原生会话列表可用完整 ID 对照定位，直接跳转能力另验。

每实例最多保留 64 项，优先淘汰最早终态并披露省略；15 秒失联后显示当前状态不可用、保留最后事实。旧 Runtime 返回新路由 404 时，插件提示更新，同时继续发送原表情。先更新本轮 Runtime/桌面，再更新插件；protocolVersion=1、既有表达客户端与 SQLite 格式沿用原版。[契约与迁移](../../docs/architecture.md#session-observations)及[实机证据](../../docs/audits/2026-11-14-session-observations.md)。

在 dsh 原生界面创建任务，小招随真实宿主事件显示工作、思考、等待、完成或出错。多个会话同时工作时，一个会话完成不会覆盖其他工作；完成/出错动画在 3 秒后结束，插件退出或失联最迟 15 秒回到其他有效来源的状态或待机。

宿主工程能力仍只观察。任务派发、补充输入、取消和操作审批在 dsh 原生界面进行；反向派发保持关闭。对话、个人待办提醒与可选按键语音由独立 Runtime 提供；默认模型和语音均关闭，模型地址、密钥与自身云端授权需在助手设置中显式配置，不复用 dsh 密钥。语音仍从同一 `/maneki assistant` 入口进入；仅明确选择并授权 dsh 识别时，插件接收当前轮录音并调用宿主声明为本地的识别服务。插件不自行采集麦克风、不持久化录音；安装步骤和验收边界见[语音说明](../../docs/voice.md)。没有 overlay 或完整工程结果恢复承诺。插件重载期间已有工作的状态要等下一条宿主事件才重新建立，不能把待机当作任务已结束。

插件仍为 `0.3.0`，桌面与 Runtime 须一起更新到 `0.2.0-alpha.2`；管理入口先核验身份与精确发行版本，不复用旧后台。当前数据库为 v6，升级前按源版本备份 `runtime.db.bak-<版本>`，旧 Runtime 拒绝新库；回退须停止后台并恢复对应备份。既有表达凭证不扩权，撤销的 `assistant-client.json` 不自动重新签发。对话管理增量不增加插件权限，查询/修改/澄清仍在 `/maneki assistant` 的独立个人入口办理。

Windows 上的基础插件和语音验收记录对应 dsh `0.2.1-rc.5`。源码版额外声明兼容 `0.2.2-rc.1`，下节列出该版本已验证的场景。macOS/Linux 尚待验证。

## 让 dsh 读取开工简报

在已配对的观察插件上，dsh 向小招上报会话事件。要让 dsh 查询到期待办和仍在等待的会话，须另行为这个 dsh profile 授予 `briefing_read`。授权范围包含**所有项目**的到期待办标题、日期和等待会话标识；dsh 可以把工具结果交给它配置的模型。

先按[仓库接入指南](../../README.md#接入小招)构建源码并启动 Runtime。以下 PowerShell 示例在仓库根目录执行，使用指南的独立 Runtime 目录和端口。在其他目录启动 dsh 时保留已解析的绝对路径，便可继续在原项目工作。

```powershell
$runtimeDir = Join-Path $env:LOCALAPPDATA 'ManekiIntegrationDemo'
$port = 18101
$env:MANEKI_BRIEFING_URL = "http://127.0.0.1:$port"
$env:MANEKI_BRIEFING_BRIDGE = (Resolve-Path packages/cli/dist/briefing-mcp.js).Path
$env:MANEKI_BRIEFING_TOKEN_FILE = node packages/runtime/scripts/pair-briefing-client.mjs "$runtimeDir" $port dsh-web --allow-briefing-read
if ($LASTEXITCODE -ne 0) { throw '简报配对失败' }
$briefingPatch = (Resolve-Path apps/dsh-plugin/briefing.patch.example.yml).Path
dsh --profile web --patch "$briefingPatch"
```

dsh 原生 MCP 客户端使用 stdio 加载桥，注册无参工具 `mcp__maneki__maneki_get_briefing`。可向已配置的 dsh 助手提问「今天有哪些到期事项，哪个会话在等我？」。观察插件须连接同一个 Runtime，当前宿主的等待会话才会出现在结果中。`onlineSources` 是在线的上报来源数，零表示当前没有在线来源可供判断。

退出这次带 patch 的 dsh 即停用该入口。要使已运行的桥也失去读取权，在相同目录和端口上撤销该名称的凭证。

```powershell
node packages/runtime/scripts/pair-briefing-client.mjs "$runtimeDir" $port dsh-web --revoke-briefing-read
```

Windows、Node 24.12.0、dsh `0.2.2-rc.1` 的隔离 profile 已验证工具发现、读取和撤销。由测试驱动的 turn 调用 dsh 内置提问工具，等待期间简报列出对应会话，答复并结束后等待列表清空；宿主退出后来源标记为离线。该版本另验了人类命令注册与未配置 Provider 的语音服务加载。模型的自主工具选择、原生管理弹窗及实际录音在这个版本上仍待验。[验收记录](../../docs/audits/2026-11-21-work-briefing.md)

从仓库根目录构建后，运行 `node scripts/acceptance-dsh-briefing.mjs` 可用本机 npm 安装的 dsh `0.2.2-rc.1` 重跑这条简报链路，也可在命令末尾传入 dsh 的 `lib/bin.js` 绝对路径。脚本创建临时 profile 和 Runtime，结束时清理凭证与目录。

## 让 dsh 安排一次提醒

在已配置模型的 dsh 中输入「半小时后提醒我休息」。工具调用成功后，小招返回提醒 ID 和到期时间。可以退出 dsh，保持小招后台运行，到期时由它投递通知。小招的个人助手面板可查看、改期和取消提醒。dsh 也可分别启用查询、改期和取消。

先从源码构建并启动 Runtime。以下示例在仓库根目录运行，使用接入指南的演示目录和端口。`reminder_create` 允许这个具名客户端安排多条提醒，提醒文字会出现在本机通知中。为每个需要使用它的 profile 单独命名和授权。[启动示例](../../README.md#接入小招)

```powershell
$runtimeDir = Join-Path $env:LOCALAPPDATA 'ManekiIntegrationDemo'
$port = 18101
$env:MANEKI_REMINDER_URL = "http://127.0.0.1:$port"
$env:MANEKI_REMINDER_BRIDGE = (Resolve-Path packages/cli/dist/reminder-mcp.js).Path
$env:MANEKI_REMINDER_TOKEN_FILE = node packages/runtime/scripts/pair-reminder-client.mjs "$runtimeDir" $port dsh-web --allow-reminder-create
if ($LASTEXITCODE -ne 0) { throw '提醒配对失败' }
$reminderPatch = (Resolve-Path apps/dsh-plugin/reminder.patch.example.yml).Path
dsh --profile web --patch "$reminderPatch"
```

dsh 的原生 MCP 客户端将该工具注册为 `mcp__maneki_reminders__maneki_remind`。半小时对应 `afterSeconds: 1800`，本例正文是「休息」。同一意图遇到超时或回执丢失时，复用原 `requestId`、延时和正文；另一条新意图使用新 ID。[请求与重试契约](../../docs/architecture.md#agent-reminders)

要收回这个 profile 的创建权限，执行以下命令。已经安排的提醒会继续由 Runtime 调度。

```powershell
node packages/runtime/scripts/pair-reminder-client.mjs "$runtimeDir" $port dsh-web --revoke-reminder-create
```

**在 Windows 重跑验收会发出一条真实的「休息」通知。** 从已构建的仓库运行 `node scripts/acceptance-dsh-reminder.mjs`，也可追加本机 dsh 的 `lib/bin.js` 路径。验收在隔离 profile 中将上述中文句子送进 dsh 的原生对话循环，由本地确定性 Provider 解析并请求工具。Windows、Node 24.12.0、dsh `0.2.2-rc.1` 实测重试返回同一回执，撤销后新建被拒。宿主退出后，脚本推进测试 Runtime 的时钟并重启后台，验证到期前仍待投递、到期时 Windows 受理一次、再重启后投递次数仍为一。在线模型自主选择工具、用户是否看到系统横幅及其他平台仍待验证。[验收脚本](../../scripts/acceptance-dsh-reminder.mjs)

## 让 dsh 查询和取消自己安排的提醒

在 dsh 中安排提醒后，可继续说「帮我看看还有哪些提醒，把刚才那个休息提醒取消掉」。`reminder_read` 允许读取这个 profile 创建且尚未开始投递的提醒正文、到期时间、ID 和版本。`reminder_cancel` 允许取消同范围内的提醒。dsh 可以把查询结果交给它配置的模型。两项权限须分别授权，并使用上节已登记的创建身份名称。桌面或其他 agent 安排的提醒在小招个人助手面板管理。

更新 Runtime 和 CLI 后，在仓库根目录执行。以下沿用上节的 `$runtimeDir`、`$port`、`$reminderPatch` 和 `MANEKI_REMINDER_URL`。

```powershell
$env:MANEKI_REMINDER_READ_BRIDGE = (Resolve-Path packages/cli/dist/reminder-read-mcp.js).Path
$env:MANEKI_REMINDER_READ_TOKEN_FILE = node packages/runtime/scripts/pair-reminder-read-client.mjs "$runtimeDir" $port dsh-web --allow-reminder-read
if ($LASTEXITCODE -ne 0) { throw '提醒查询配对失败' }
$env:MANEKI_REMINDER_CANCEL_BRIDGE = (Resolve-Path packages/cli/dist/reminder-cancel-mcp.js).Path
$env:MANEKI_REMINDER_CANCEL_TOKEN_FILE = node packages/runtime/scripts/pair-reminder-cancel-client.mjs "$runtimeDir" $port dsh-web --allow-reminder-cancel
if ($LASTEXITCODE -ne 0) { throw '提醒取消配对失败' }
$readPatch = (Resolve-Path apps/dsh-plugin/reminder-read.patch.example.yml).Path
$cancelPatch = (Resolve-Path apps/dsh-plugin/reminder-cancel.patch.example.yml).Path
dsh --profile web --patch "$reminderPatch" --patch "$readPatch" --patch "$cancelPatch"
```

查询和取消分别注册为 `mcp__maneki_reminder_read__maneki_list_reminders`、`mcp__maneki_reminder_cancel__maneki_cancel_reminder`。按需加载对应 patch，例如只读场景只加载 `$readPatch`。取消时先查询当前列表，用目标的完整 `reminderId` 与 `version` 提交。遇到同名时，可以结合上一轮创建回执定位。仍有歧义时，请用户确认具体提醒。发生超时或回执丢失时，用原请求 ID、提醒 ID 和版本重取回执。[查询与取消契约](../../docs/architecture.md#agent-reminder-management)

在同一 Runtime 上按需执行对应撤销命令。撤销后其他已授予权限和仍待投递的提醒保留。若需轮换已撤销的权限，先登记新的创建身份名称。

```powershell
node packages/runtime/scripts/pair-reminder-read-client.mjs "$runtimeDir" $port dsh-web --revoke-reminder-read
node packages/runtime/scripts/pair-reminder-cancel-client.mjs "$runtimeDir" $port dsh-web --revoke-reminder-cancel
```

从已构建的仓库运行 `node scripts/acceptance-dsh-reminder-management.mjs`，可用隔离 profile、真实 dsh 原生对话循环和本地确定性 Provider 检查两轮场景。脚本检查同名提醒的精确选择、版本冲突、回执重试和撤销隔离，并用注入的通知器核对到期投递。脚本也接受 dsh 的 `lib/bin.js` 绝对路径。[验收脚本](../../scripts/acceptance-dsh-reminder-management.mjs)

## 让 dsh 改期自己安排的提醒

在 dsh 安排「半小时后提醒我休息」后，可以继续说「把刚才那个休息提醒改到一小时后」。`reminder_reschedule` 单独授权，允许改期同名创建身份尚未开始投递的提醒。先更新 Runtime 和 CLI，再沿用上文 `dsh-web` 的创建和查询凭证、`$reminderPatch`、`$readPatch`、`$runtimeDir`、`$port` 及 `MANEKI_REMINDER_URL`。改期场景只需配对创建、查询、改期这三项。

```powershell
$env:MANEKI_REMINDER_RESCHEDULE_BRIDGE = (Resolve-Path packages/cli/dist/reminder-reschedule-mcp.js).Path
$env:MANEKI_REMINDER_RESCHEDULE_TOKEN_FILE = node packages/runtime/scripts/pair-reminder-reschedule-client.mjs "$runtimeDir" $port dsh-web --allow-reminder-reschedule
if ($LASTEXITCODE -ne 0) { throw '提醒改期配对失败' }
$reschedulePatch = (Resolve-Path apps/dsh-plugin/reminder-reschedule.patch.example.yml).Path
dsh --profile web --patch "$reminderPatch" --patch "$readPatch" --patch "$reschedulePatch"
```

dsh 注册工具 `mcp__maneki_reminder_reschedule__maneki_reschedule_reminder`。先查询，结合上一轮创建回执找出同一条记录，再提交完整 `reminderId`、当前 `version`、新 `requestId` 和 `afterSeconds: 3600`。同名仍无法区分时请用户确认。版本冲突时重新查询并确认。成功时保留原提醒 ID 与正文，从本次受理时间起计算新到期时间，并返回新版本。超时或回执丢失后使用完全相同的四个参数重取原回执。[改期契约](../../docs/architecture.md#agent-reminder-reschedule)

撤销改期权限后，其他权限和已安排的时间继续有效。

```powershell
node packages/runtime/scripts/pair-reminder-reschedule-client.mjs "$runtimeDir" $port dsh-web --revoke-reminder-reschedule
```

Windows 上的 dsh `0.2.2-rc.1` 已通过两轮隔离验收。本地确定性 Provider 经原生对话循环调用三个 MCP 桥。用注入的通知器验证原到期点只投递同名对照，改期的目标只在新到期点投递一次。在线模型的自主工具选择与 Windows 系统通知横幅仍待验证。

从已构建的仓库运行 `node scripts/acceptance-dsh-reminder-reschedule.mjs` 可重跑，也可附上本机 dsh 的 `lib/bin.js` 绝对路径。[验收脚本](../../scripts/acceptance-dsh-reminder-reschedule.mjs)

## 让 dsh 安排每日提醒

在已配置模型的 dsh 中输入「每天上午九点提醒我休息」。成功回执会给出系列 ID、每日时间、适用时区和下一次到期时间。小招使用创建时的助手设置时区，调整默认时区只影响新建规则。dsh 退出后，运行中的小招后台继续调度。

给每个需要接入的 profile 单独签发 `reminder_recurring`。这个权限可以创建、查询和取消该身份自己的每日、工作日和指定星期规则。dsh 可以把工具返回的提醒内容交给它配置的模型。先从源码构建并启动新版 Runtime，以下命令在仓库根目录运行，沿用演示目录和端口。

```powershell
$runtimeDir = Join-Path $env:LOCALAPPDATA 'ManekiIntegrationDemo'
$port = 18101
$env:MANEKI_REMINDER_URL = "http://127.0.0.1:$port"
$env:MANEKI_REMINDER_RECURRING_BRIDGE = (Resolve-Path packages/cli/dist/reminder-recurring-mcp.js).Path
$env:MANEKI_REMINDER_RECURRING_TOKEN_FILE = node packages/runtime/scripts/pair-reminder-recurring-client.mjs "$runtimeDir" $port dsh-web --allow-reminder-recurring
if ($LASTEXITCODE -ne 0) { throw '周期提醒配对失败' }
$dailyPatch = (Resolve-Path apps/dsh-plugin/reminder-recurring.patch.example.yml).Path
dsh --profile web --patch "$dailyPatch"
```

dsh 注册 `mcp__maneki_reminder_recurring__maneki_remind_daily`、`mcp__maneki_reminder_recurring__maneki_list_daily_reminders` 和 `mcp__maneki_reminder_recurring__maneki_cancel_daily_reminder`。创建时传入 `localTime: "09:00"`、正文 `休息` 和新 `requestId`。取消时先查列表，核对所选规则的完整 `seriesId`，再用新的 `requestId` 取消。如果多条规则仍无法区分，请用户选定。超时或回执丢失后，用原请求 ID 和完整参数重试。取消后重试旧创建请求只会取回原回执。[每日提醒契约](../../docs/architecture.md#daily-reminders)

下列命令撤销这个 profile 的每日、工作日和指定星期提醒权限。已创建的规则会继续调度。如需同时停止提醒，请先取消对应系列，再撤销权限。

```powershell
node packages/runtime/scripts/pair-reminder-recurring-client.mjs "$runtimeDir" $port dsh-web --revoke-reminder-recurring
```

从已构建的仓库运行 `node scripts/acceptance-dsh-reminder-recurring.mjs` 可重跑隔离验收，也可附上本机 dsh 的 `lib/bin.js` 绝对路径。脚本用本地确定性 Provider 驱动真实 dsh 对话循环，用注入的通知器记录 Runtime 在模拟到期时刻的投递。[验收脚本](../../scripts/acceptance-dsh-reminder-recurring.mjs)

## 让 dsh 安排工作日提醒

在已配置模型的 dsh 中输入「每个工作日上午九点提醒我休息」。工作日按规则时区的周一至周五计算，遇到节假日或调休仍以星期几为准。成功回执包含系列 ID、时间、创建时的助手时区和下次到期时间。周五投递后，调度从周一查找下一个有效时刻，夏令时使指定分钟不存在或不唯一时跳过当天。dsh 退出后，运行中的小招后台继续调度。[工作日提醒契约](../../docs/architecture.md#weekday-reminders)

从源码构建并启动新版 Runtime，按上一节设置 `MANEKI_REMINDER_URL` 和 `MANEKI_REMINDER_RECURRING_TOKEN_FILE`。已有的 `reminder_recurring` 凭证可以直接使用。只需操作工作日规则时，加载工作日 patch。需要同时操作每日规则时，再加载 `$dailyPatch`。

```powershell
$env:MANEKI_REMINDER_WEEKDAYS_BRIDGE = (Resolve-Path packages/cli/dist/reminder-weekdays-mcp.js).Path
$weekdayPatch = (Resolve-Path apps/dsh-plugin/reminder-weekdays.patch.example.yml).Path
dsh --profile web --patch "$weekdayPatch"
```

dsh 注册 `mcp__maneki_reminder_weekdays__maneki_remind_weekdays`、`mcp__maneki_reminder_weekdays__maneki_list_weekday_reminders` 和 `mcp__maneki_reminder_weekdays__maneki_cancel_weekday_reminder`。创建时传入 `localTime: "09:00"`、正文 `休息` 和新 `requestId`。可以说「取消每个工作日上午九点的休息提醒」。先查询工作日列表，确认完整 `seriesId` 后用新的 `requestId` 取消。多条规则仍无法区分时，请用户选定。超时或回执丢失时使用完全相同的请求 ID 和参数重试，已取消规则不会因重放创建而恢复。

从已构建的仓库运行 `node scripts/acceptance-dsh-reminder-weekdays.mjs` 可重跑隔离验收，也可附上本机 dsh 的 `lib/bin.js` 绝对路径。脚本用本地确定性 Provider 驱动真实 dsh 对话循环，在 `Asia/Shanghai` 观察 Runtime 向注入通知器投递，覆盖周五、同日重启、周末、周一和取消后。这项验收的范围是工具接入和调度调用，在线模型自主选择工具和系统通知横幅仍待验证。[验收脚本](../../scripts/acceptance-dsh-reminder-weekdays.mjs)

## 让 dsh 在指定星期提醒

在已配置模型的 dsh 中输入「每周一、三、五上午九点提醒我休息」。规则按创建时的助手时区和指定的当地时刻执行，节假日和调休仍按星期计算。成功回执给出系列 ID、星期列表、时间、时区和下次到期时间。dsh 退出后，运行中的小招后台继续调度。[指定星期提醒契约](../../docs/architecture.md#weekly-reminders)

从源码构建并启动新版 Runtime，沿用上面的 `MANEKI_REMINDER_URL` 和 `MANEKI_REMINDER_RECURRING_TOKEN_FILE`。已有 `reminder_recurring` 凭证可直接使用。按需加载指定星期 patch。

```powershell
$env:MANEKI_REMINDER_WEEKLY_BRIDGE = (Resolve-Path packages/cli/dist/reminder-weekly-mcp.js).Path
$weeklyPatch = (Resolve-Path apps/dsh-plugin/reminder-weekly.patch.example.yml).Path
dsh --profile web --patch "$weeklyPatch"
```

dsh 注册 `mcp__maneki_reminder_weekly__maneki_remind_weekly`、`mcp__maneki_reminder_weekly__maneki_list_weekly_reminders` 和 `mcp__maneki_reminder_weekly__maneki_cancel_weekly_reminder`。上述输入对应 `daysOfWeek: [1, 3, 5]`、`localTime: "09:00"`、`message: "休息"` 和新的 `requestId`。星期按 ISO 编号，范围为 1（周一）至 7（周日）。取消前先查询列表，按星期、时刻和正文找到目标，确认完整 `seriesId`，再用新的 `requestId` 取消。有多条匹配时，请用户选定。超时或回执丢失后，沿用原请求 ID 和参数。已取消规则的旧创建请求仍返回原回执。

构建后运行 `node scripts/acceptance-dsh-reminder-weekly.mjs` 可重跑 Windows dsh `0.2.2-rc.1` 的隔离验收，也可附上本机 dsh 的 `lib/bin.js` 绝对路径。脚本用本地确定性 Provider 驱动 dsh 原生对话循环，在模拟时间下用注入通知器核验指定星期、同日重启和取消后的调度调用。在线模型自主选择工具和系统通知横幅待单独验证。[验收脚本](../../scripts/acceptance-dsh-reminder-weekly.mjs)

## 让 dsh 改期自己安排的每日提醒

每日提醒创建后，可以在 dsh 说「把每天上午九点的休息提醒改到每天上午十点」。先更新 Runtime 和 CLI，沿用上面的 `$runtimeDir`、`$port`、`MANEKI_REMINDER_URL` 和已登记的 `dsh-web` 名称，再单独配对 `reminder_recurring_reschedule`。该权限可向 dsh 提供此身份的活跃每日、工作日和指定星期改期目标及正文，并更改相应时刻。只需要每日改期时，加载下面这一项 patch 即可。仍需创建、查询每日普通列表或取消时，同时加载 `$dailyPatch`。

```powershell
$env:MANEKI_REMINDER_RECURRING_RESCHEDULE_BRIDGE = (Resolve-Path packages/cli/dist/reminder-recurring-reschedule-mcp.js).Path
$env:MANEKI_REMINDER_RECURRING_RESCHEDULE_TOKEN_FILE = node packages/runtime/scripts/pair-reminder-recurring-reschedule-client.mjs "$runtimeDir" $port dsh-web --allow-reminder-recurring-reschedule
if ($LASTEXITCODE -ne 0) { throw '每日提醒改期配对失败' }
$dailyReschedulePatch = (Resolve-Path apps/dsh-plugin/reminder-recurring-reschedule.patch.example.yml).Path
dsh --profile web --patch "$dailyReschedulePatch"
```

dsh 注册 `mcp__maneki_daily_move__maneki_list_daily_reschedule_targets` 和 `mcp__maneki_daily_move__maneki_reschedule_daily_reminder`。先查目标，按正文和原时间核对唯一规则，再传完整 `seriesId`、当前 `version`、新的 `requestId` 和 `localTime: "10:00"`。有多个匹配时请用户选定。遇到版本冲突，重新查询并确认。回执丢失或请求超时时，用原请求 ID 和所有原参数重试，可取回原回执。

改期保留系列 ID、正文和时区。原规则当天还有一次待投递提醒且十点还没到时，当天十点会按新时间调度。当天已认领时，从下一个有效日期起按新时间调度。下列命令同时撤销此身份的每日、工作日和指定星期改期权限。已安排的时间与其他已签发权限继续有效。[每日提醒改期契约](../../docs/architecture.md#daily-reminder-reschedule)

```powershell
node packages/runtime/scripts/pair-reminder-recurring-reschedule-client.mjs "$runtimeDir" $port dsh-web --revoke-reminder-recurring-reschedule
```

Windows 上的 dsh `0.2.2-rc.1` 已通过这两个场景的隔离验收。脚本用本地确定性 Provider 经 dsh 原生对话循环调用 MCP，用模拟时间和注入的通知器记录投递。在线模型的自主工具选择和系统通知横幅需要另行验证。构建后运行 `node scripts/acceptance-dsh-reminder-recurring-reschedule.mjs` 可重跑，也可附上本机 dsh 的 `lib/bin.js` 绝对路径。[验收脚本](../../scripts/acceptance-dsh-reminder-recurring-reschedule.mjs)

## 让 dsh 改期工作日提醒

对 dsh 说「把每个工作日上午九点的休息提醒改到上午十点」。先更新 Runtime 和 CLI，沿用上面的 `MANEKI_REMINDER_URL` 和同名 `reminder_recurring_reschedule` 凭证。已有每日改期凭证可直接设置为 `MANEKI_REMINDER_RECURRING_RESCHEDULE_TOKEN_FILE`。首次签发请沿用上一节的配对命令。单独加载下面的 patch 即可查询工作日改期目标和改期。仍需创建、查询普通列表或取消时，同时加载 `$weekdayPatch`。

```powershell
$env:MANEKI_REMINDER_WEEKDAYS_RESCHEDULE_BRIDGE = (Resolve-Path packages/cli/dist/reminder-weekdays-reschedule-mcp.js).Path
$weekdayReschedulePatch = (Resolve-Path apps/dsh-plugin/reminder-weekdays-reschedule.patch.example.yml).Path
dsh --profile web --patch "$weekdayReschedulePatch"
```

dsh 注册 `mcp__maneki_wday_move__maneki_list_weekday_reschedule_targets` 和 `mcp__maneki_wday_move__maneki_reschedule_weekday_reminder`。先按旧时刻和正文找到唯一目标，再传完整 `seriesId`、当前 `version`、新 `requestId` 和 `localTime: "10:00"`。有多个匹配时请用户选定。遇到版本冲突，重新查询并确认。回执丢失或请求超时时，用原请求 ID 和所有原参数重试，可取回原回执。每日和工作日改期共用该身份的请求 ID。

周五九点尚未认领且十点未到时，可以改到周五十点。周五九点已认领时，从下一个有效工作日起使用新时刻。提醒仍按原时区的周一至周五调度。每日和工作日共用上一节的改期撤销命令。[工作日改期契约](../../docs/architecture.md#weekday-reminder-reschedule)

构建后运行 `node scripts/acceptance-dsh-reminder-weekdays-reschedule.mjs` 可重跑 dsh `0.2.2-rc.1` 的两组隔离验收，也可附上本机 dsh 的 `lib/bin.js` 绝对路径。脚本用本地确定性 Provider 经原生对话调用 MCP，用模拟时间与注入通知器核验旧时刻、新时刻、周末和周一的投递。[验收脚本](../../scripts/acceptance-dsh-reminder-weekdays-reschedule.mjs)

## 让 dsh 改期指定星期提醒

对 dsh 说「把每周一、三、五上午九点的休息提醒改到上午十点」。先更新 Runtime 和 CLI。沿用 `MANEKI_REMINDER_URL` 和同名 `reminder_recurring_reschedule` 凭证。首次签发时使用每日改期一节的配对命令。单独加载下面的 patch 即可查询指定星期的改期目标和改期。需要创建、查询普通列表或取消时，同时加载 `$weeklyPatch`。

```powershell
$env:MANEKI_REMINDER_WEEKLY_RESCHEDULE_BRIDGE = (Resolve-Path packages/cli/dist/reminder-weekly-reschedule-mcp.js).Path
$weeklyReschedulePatch = (Resolve-Path apps/dsh-plugin/reminder-weekly-reschedule.patch.example.yml).Path
dsh --profile web --patch "$weeklyReschedulePatch"
```

dsh 注册 `mcp__maneki_week_move__maneki_list_weekly_reschedule_targets` 和 `mcp__maneki_week_move__maneki_reschedule_weekly_reminder`。先查询列表，核对目标的 `daysOfWeek: [1, 3, 5]`、正文和原时刻，再传完整 `seriesId`、当前 `version`、新 `requestId` 和 `localTime: "10:00"`。有多个匹配时请用户选定。遇到版本冲突时重新查询并确认。回执丢失或请求超时时，可用原请求 ID 和所有原参数取回原回执。三个重复周期共用该身份的改期请求 ID 和撤销命令。

只提交新时刻时，改期沿用原系列的星期集合与时区。当天九点尚未认领且十点未到时，可以改到当天十点。当天已认领时，从下一个有效的指定星期起使用新时刻。[指定星期改期契约](../../docs/architecture.md#weekly-reminder-reschedule)

构建后运行 `node scripts/acceptance-dsh-reminder-weekly-reschedule.mjs` 可重跑隔离验收，也可附上本机 dsh 的 `lib/bin.js` 绝对路径。脚本使用本地确定性 Provider，经 dsh 原生对话调用 MCP，并用模拟时间和注入通知器核验旧时刻、新时刻、跳过日和已认领日期。[验收脚本](../../scripts/acceptance-dsh-reminder-weekly-reschedule.mjs)

### 在 dsh 更换指定星期

对 dsh 说「把每周一、三、五上午十点的休息提醒改成每周二、四上午十点」。更新 Runtime 和 CLI 后继续使用上面的 patch 和同名改期凭证。先查询目标，按原星期、正文和时刻定位唯一系列，再向同一改期工具提交查到的完整 `seriesId`、当前 `version`、新 `requestId`、原时刻 `localTime: "10:00"` 和新集合 `daysOfWeek: [2, 4]`。有多个匹配时请用户选定。

`daysOfWeek` 会替换整个星期集合。只改星期时，时刻、正文、时区和系列 ID 沿用原值。下次到期可能早于原规则的下次到期，同一系列的每个本地日期仍至多认领一次。请求超时或回执丢失时，可沿用原请求 ID 和参数重放，星期数组换序也返回原回执。[修改星期集合契约](../../docs/architecture.md#weekly-reminder-change-days)

构建后运行 `node scripts/acceptance-dsh-reminder-weekly-change-days.mjs`，也可附上本机 dsh `lib/bin.js` 的绝对路径。脚本用本地确定性 Provider 经 dsh `0.2.2-rc.1` 的原生对话调用 MCP，以模拟时间和注入通知器核验更换星期、重启和同日时钟回拨后的投递。[验收脚本](../../scripts/acceptance-dsh-reminder-weekly-change-days.mjs)

## 旧手工凭证模式（继续兼容）

先从仓库构建：`pnpm -r build`。桌面和 Runtime 必须使用本轮构建，旧安装版没有新的状态接口。构建原生壳可运行 `pnpm --filter @maneki-pet/desktop tauri build --no-bundle`；它使用已准备的本地动作包。

启动与插件匹配的 Runtime。已有手工部署可以继续使用为该插件独立签发的纯文本 `express` 凭证。把 `MANEKI_TOKEN_FILE` 指向原凭证，`MANEKI_RUNTIME_URL` 指向受信的本机 Runtime 地址；仓库与 dsh profile 中仅保存路径。新安装可使用上方的原生 `/maneki pair` 流程。第三方状态客户端的配对文件和启动示例见[仓库接入指南](../../README.md#接入小招)。

然后在仓库根目录执行（原工作目录就是 dsh 的默认项目）：

```powershell
dsh --profile web --patch ./apps/dsh-plugin/observer.patch.example.yml
```

其他项目使用 patch 的绝对路径；示例的插件 `name` 已指向 `C:/myProject/maneki-pet`，checkout 在其他目录时改为实际的绝对 `dist/index.js` 路径。不要更换任务目录来迁就插件。`MANEKI_RUNTIME_URL` 可指定其他回环端口；仅允许 `http://127.0.0.1:<port>`，不跟随重定向。显式设置 `baseUrl/tokenFile` 或原环境变量时采用旧手工观察模式，不自动拉起 Runtime，也不开放上述原生管理命令。移除这些手工选项后方可使用新配对流程；不把原表达凭证升级为管理凭证。

关闭 dsh 或移除本次 `--patch` 即可停用。撤销凭证可由受信管理端调用 `/v1/clients/<client-id>/revoke`；它只影响此插件客户端。插件不上传提示词、工具参数、回答或路径，不保存会话转录，不持有任务权限。
