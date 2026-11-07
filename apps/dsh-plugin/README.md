# dsh 基础插件（Windows）

`0.2.0` 在已有状态观察上增加共享助手的连接、原生配对、显示与退出入口。命令通过 dsh `0.2.1-rc.5` 的人类命令注册表处理，不发送给模型；插件只取得本 profile 的 `express` 客户端凭证，不读取 root。

## 安装与配对

桌面与 Runtime 须使用本轮一起构建的版本。安装布局包含相邻的 `maneki-desktop.exe`、`maneki-runtime.exe` 与 `resources/maneki-runtime-bundle.js`；只替换壳或使用旧安装版不支持管理协议。先运行更新后的桌面一次，或执行已安装的 `maneki-desktop.exe --assistant register`，将固定入口登记到 `%APPDATA%/com.manekipet.desktop/installation.json`。插件不会下载、安装或运行项目配置给出的命令。

从本仓库构建并打包（产物不发布到 npm）：

```powershell
pnpm -r build
pnpm --filter @maneki-pet/dsh-plugin pack --pack-destination C:/maneki-lab
dsh plugin --profile web add C:/maneki-lab/maneki-pet-dsh-plugin-0.2.0.tgz
```

重启 `dsh web`，然后在 dsh 输入 `/maneki pair`，检查原生确认框中的 profile 与权限后手动同意。首次连接只会启动已安装 Runtime 并提示配对，不自动授权；已配对时后续启动可复用凭证。撤销或损坏凭证不会静默重配，须由受信管理入口核查并显式移除对应的 `runtime/dsh-client-<profileId>.json` 后再配对。

| 命令 | 行为 |
|---|---|
| `/maneki status` | 核验本机服务身份并查询后台状态，不启动服务 |
| `/maneki connect` | 启动或连接同一 Runtime，复用已授权凭证 |
| `/maneki pair` | 原生确认后，为当前 profile 单独授予状态表达权限 |
| `/maneki show` | 启动或显示同一只桌宠，不重复创建窗口 |
| `/maneki quit` | 原生确认后停止助理后台并关闭桌宠；不取消外部 dsh 任务 |

本地 profile 的 `cordis.patch.yml` 可覆盖接入选项：

```yaml
- id: maneki-observer
  config:
    profileId: web
    showOnConnect: true
```

其他 profile 请配置不同的 `profileId`（1–64 位字母、数字、下划线或连字符，Windows 不区分大小写），以分别配对和撤销；助手 Runtime 与数据库仍共享。相同 ID 视为同一个接入客户端。`showOnConnect` 默认开启，只在连接成功后请求显示。不同项目不要覆盖个人助手的隐私、语音或勿扰偏好，本轮尚未提供助手全局设置面板。

关闭 dsh、卸载插件或托盘“关闭桌宠（后台继续）”只断开视图，Runtime 保留；明确“退出助理”才停止后台。当前插件执行 quit 后不会自行再启动，需显式 connect/show；宿主重新启动/插件重新启用会按上述启动配置连接。缺安装、身份不符、配对失败等情况明确降级，dsh 继续运行。

本轮自动化、Windows 发行布局及真实 dsh 插件加载的验证边界见[验收记录](../../docs/audits/2026-11-07-dsh-plugin-management.md)。原生确认框已观察，人工同意/拒绝及托盘退出点击待用户验收；不以底层管理 API 的通过替代该项。安装器升级/卸载、macOS/Linux 未验证。

## 状态观察与兼容入口

在 dsh 原生界面创建任务，小招随真实宿主事件显示工作、思考、等待、完成或出错。多个会话同时工作时，一个会话完成不会覆盖其他工作；完成/出错动画在 3 秒后结束，插件退出或失联最迟 15 秒回到其他有效来源的状态或待机。

业务能力仍只观察。任务派发、补充输入、取消和操作审批在 dsh 原生界面进行；反向派发保持关闭，聊天、语音和待办提醒尚未启用。没有 overlay 或完整结果恢复承诺。插件重载期间已有工作的状态要等下一条宿主事件才重新建立，不能把待机当作任务已结束。

已验证宿主：Windows、Node 24、dsh `0.2.1-rc.5`。其他版本与 macOS/Linux 未验证。无需语音、LLM Provider 或外部记忆配置；dsh 自身模型配置和数据去向独立于 Maneki。

### 旧手工凭证模式（继续兼容）

先从仓库构建：`pnpm -r build`。桌面和 Runtime 必须使用本轮构建，旧安装版没有新的状态接口。构建原生壳可运行 `pnpm --filter @maneki-pet/desktop tauri build --no-bundle`；它使用已准备的本地动作包。

启动新构建的桌面（或手动启动同版本共享 Runtime），确认 `http://127.0.0.1:18100/v1/health` 可达。受信管理端通过现有 `/v1/pair` 为宿主单独签发 `express` 凭证，插件只读该凭证文件，不能读取 root-token。以下 PowerShell 在本机管理端执行，凭证不会输出；默认 Runtime 目录与 Tauri `com.manekipet.desktop` 的 loader 一致，可用 `-RuntimeDir` 对应路径替换变量：

```powershell
$runtimeDir = Join-Path $env:APPDATA 'com.manekipet.desktop\runtime'
$clientDir = Join-Path $env:APPDATA 'com.manekipet.desktop\dsh-observer'
New-Item -ItemType Directory -Path $clientDir -Force | Out-Null
$rootToken = (Get-Content -LiteralPath (Join-Path $runtimeDir 'root-token') -Raw).Trim()
$pair = Invoke-RestMethod -Uri 'http://127.0.0.1:18100/v1/pair' -Method Post `
  -Headers @{ Authorization = "Bearer $rootToken" } -ContentType 'application/json' `
  -Body '{"name":"dsh-observer","scopes":"express"}'
$env:MANEKI_TOKEN_FILE = Join-Path $clientDir 'client-token'
[IO.File]::WriteAllText($env:MANEKI_TOKEN_FILE, $pair.token)
$pair.clientId | Set-Content -LiteralPath (Join-Path $clientDir 'client-id')
Remove-Variable rootToken, pair
```

然后在仓库根目录执行（原工作目录就是 dsh 的默认项目）：

```powershell
dsh --profile web --patch ./apps/dsh-plugin/observer.patch.example.yml
```

其他项目使用 patch 的绝对路径；示例的插件 `name` 已指向 `C:/myProject/maneki-pet`，checkout 在其他目录时改为实际的绝对 `dist/index.js` 路径。不要更换任务目录来迁就插件。`MANEKI_RUNTIME_URL` 可指定其他回环端口；仅允许 `http://127.0.0.1:<port>`，不跟随重定向。显式设置 `baseUrl/tokenFile` 或原环境变量时采用旧手工观察模式，不自动拉起 Runtime，也不开放上述原生管理命令。移除这些手工选项后方可使用新配对流程；不把原表达凭证升级为管理凭证。

关闭 dsh 或移除本次 `--patch` 即可停用。撤销凭证可由受信管理端调用 `/v1/clients/<client-id>/revoke`；它只影响此插件客户端。插件不上传提示词、工具参数、回答或路径，不保存会话转录，不持有任务权限。
