# dsh 状态联动 MVP

在 dsh 原生界面创建任务，小招随真实宿主事件显示工作、思考、等待、完成或出错。多个会话同时工作时，一个会话完成不会覆盖其他工作；完成/出错动画在 3 秒后结束，插件退出或失联最迟 15 秒回到其他有效来源的状态或待机。

本增量只观察。任务派发、补充输入、取消和操作审批仍在 dsh 原生界面进行；Maneki 的反向派发保持关闭。没有 overlay、完整结果恢复或安装版发布承诺。插件重载期间已有工作的状态要等下一条宿主事件才重新建立，不能把待机当作任务已结束。

已验证宿主：Windows、Node 24、dsh `0.2.1-rc.5`。其他版本与 macOS/Linux 未验证。无需语音、LLM Provider 或外部记忆配置；dsh 自身模型配置和数据去向独立于 Maneki。

## 本地使用

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

其他项目使用 patch 的绝对路径；示例的插件 `name` 已指向 `C:/myProject/maneki-pet`，checkout 在其他目录时改为实际的绝对 `dist/index.js` 路径。不要更换任务目录来迁就插件。`MANEKI_RUNTIME_URL` 可指定其他回环端口；仅允许 `http://127.0.0.1:<port>`，不跟随重定向，不自动安装或拉起 Runtime。凭证失效或服务不可用时 stderr 给出固定诊断，dsh 继续运行；恢复后只发送当前活动状态。

关闭 dsh 或移除本次 `--patch` 即可停用。撤销凭证可由受信管理端调用 `/v1/clients/<client-id>/revoke`；它只影响此插件客户端。插件不上传提示词、工具参数、回答或路径，不保存会话转录，不持有任务权限。
