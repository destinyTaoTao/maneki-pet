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

在已配置模型的 dsh 中输入「半小时后提醒我休息」。工具调用成功后，小招返回提醒 ID 和到期时间。可以退出 dsh，保持小招后台运行，到期时由它投递通知。小招的个人助手面板可查看、改期和取消提醒。dsh 可按下节单独启用查询和取消。

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

## 旧手工凭证模式（继续兼容）

先从仓库构建：`pnpm -r build`。桌面和 Runtime 必须使用本轮构建，旧安装版没有新的状态接口。构建原生壳可运行 `pnpm --filter @maneki-pet/desktop tauri build --no-bundle`；它使用已准备的本地动作包。

启动与插件匹配的 Runtime。已有手工部署可以继续使用为该插件独立签发的纯文本 `express` 凭证。把 `MANEKI_TOKEN_FILE` 指向原凭证，`MANEKI_RUNTIME_URL` 指向受信的本机 Runtime 地址；仓库与 dsh profile 中仅保存路径。新安装可使用上方的原生 `/maneki pair` 流程。第三方状态客户端的配对文件和启动示例见[仓库接入指南](../../README.md#接入小招)。

然后在仓库根目录执行（原工作目录就是 dsh 的默认项目）：

```powershell
dsh --profile web --patch ./apps/dsh-plugin/observer.patch.example.yml
```

其他项目使用 patch 的绝对路径；示例的插件 `name` 已指向 `C:/myProject/maneki-pet`，checkout 在其他目录时改为实际的绝对 `dist/index.js` 路径。不要更换任务目录来迁就插件。`MANEKI_RUNTIME_URL` 可指定其他回环端口；仅允许 `http://127.0.0.1:<port>`，不跟随重定向。显式设置 `baseUrl/tokenFile` 或原环境变量时采用旧手工观察模式，不自动拉起 Runtime，也不开放上述原生管理命令。移除这些手工选项后方可使用新配对流程；不把原表达凭证升级为管理凭证。

关闭 dsh 或移除本次 `--patch` 即可停用。撤销凭证可由受信管理端调用 `/v1/clients/<client-id>/revoke`；它只影响此插件客户端。插件不上传提示词、工具参数、回答或路径，不保存会话转录，不持有任务权限。
