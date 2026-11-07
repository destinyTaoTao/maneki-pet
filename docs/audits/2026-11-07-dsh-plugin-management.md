# dsh 基础插件连接、配对、唤起与退出

日期：2026-11-07。范围：ADR-0005 后第一阶段；设计协议先以 `251e4e8` 单独提交，再实现。只覆盖 Windows、Node 24.12.0、dsh `0.2.1-rc.5`，不代表 M1/M2 整阶段或工程执行验收。

## 实现

- 插件 `0.2.0` 提供可安装的 dsh bundle 与 `/maneki status|connect|pair|show|quit` 人类命令；命令不发给模型、不记录原始输入，结果不含凭证。构建使用仓库已有 esbuild，Core/Adapter 打入单个 JS，安装包无 workspace 运行时依赖。
- Windows 原生入口登记固定安装位置，调用同目录 sidecar 管理模式；插件不持有 root。管理请求沿用 challenge/HMAC、端口绑定和协议核验，复用现有桌面配对流程，不新增数据库或 HTTP 格式。
- 首次 connect 可按需启动 Runtime，但缺授权返回 `pairing_required`；pair 必须经过原生确认，按 profile 签发仅 `express` 的客户端。撤销/损坏不自动重新授权；旧 `baseUrl/tokenFile` 观察模式继续兼容。
- 后台模式不连接 stdin MCP、不依赖窗口/宿主；Tauri 官方 single-instance 插件合并重复唤起。托盘区分“关闭桌宠（后台继续）”与“退出助理”。退出后台须原生确认并等到 Runtime 释放锁，不取消外部 dsh 工作。
- 修正与并发启动直接相关的锁边界：刚创建但未写完或损坏的锁不能被当作死进程删除；未核实持有者时明确失败。没有新增本地模型或常驻轮询进程。

## 自动验证

- 全仓 `pnpm -r build`、`pnpm -r test`、`pnpm -r typecheck` 通过，290 项 TypeScript/脚本测试通过。新增验证覆盖管理并发、首次不自动授权、profile 凭证隔离、撤销拒绝、无窗口后台启动和退出、伪服务凭证保护、插件卸载、命令输入与诊断脱敏；`git diff --check` 与原生格式检查通过。
- 原生 `cargo test --lib`：5 项通过，其中 2 项验证配对/退出被拒绝时不触达受信 helper、授权后仍保留 helper 失败；这些测试不替代实际按钮点击。
- `pnpm --filter @maneki-pet/desktop tauri build --no-bundle` 通过。复验必须使用 Tauri 构建；普通 `cargo build --release` 未启用发布资源协议，会访问开发地址，曾在验收中观察到该错误，已用标准 Tauri 发布构建重验。

## Windows 实际运行证据

测试数据与发行布局位于临时目录 `maneki-dsh-stage-41ab443586c444e0a81f6d1209d445ef`，通过独立 APPDATA/DSH_HOME 隔离。未替换用户当前安装目录、数据库、凭证或 dsh profile。

1. 复制新 release exe、固定 sidecar 与 bundle 到同目录发行布局。原生 register/status/connect 通过，首次 connect 不签发客户端；为后续验收通过受信管理命令准备隔离客户端，native connect 返回客户端凭证且不返回 root。
2. 原生 show 两次后实际只有一个 Maneki 桌宠窗口，Computer Use 观察到正式橘猫娘透明界面；同一 Runtime 锁持有者未改变。关闭桌宠后通过 native status 确认后台仍运行；管理 shutdown 后锁和监听端口释放。
3. `pnpm pack` 的内容仅包含插件 JS/声明、bundle patch、清单与说明等；真实 `dsh plugin --profile web add <本地 tgz>` 安装成功。隔离 web profile 启动后，从宿主命令注册表找到 `/maneki`，执行 status handler 得到已运行状态；宿主退出后 Runtime 仍可用。未调用付费模型。
4. 原生配对框可访问性树确认显示 `human-acceptance` 与“仅授予状态表达权限，不包含工程派发、设置或退出权限”，按钮为是/否。未代点授权；用户明确选择暂时无法操作、保留人工验收项，随后结束该隔离测试对话框进程。截图不能可靠显示该原生模态内容，因此以可访问性文本记录其呈现，不把背景截图当确认框证据。
5. 正式界面短时空闲采样：一个桌宠、全相关进程树 8 个进程约 252.48 MiB Private Bytes，Runtime 后续单点约 31.12 MiB；两次采样时刻不同，仅是本场景资源检查，不代表长期峰值或真实任务并发预算验收。验收结束后关闭测试桌宠并通过受信管理入口停止该 Runtime。

## 未验收边界

- 原生配对同意/拒绝及托盘“退出助理”的真实按钮点击，保留用户人工验收；自动测试和受信管理命令验证了守卫及底层链路，不冒充用户点击通过。
- 真实 MSI/NSIS 安装、升级、卸载与非默认安装路径生命周期未验收；本轮验证发行文件布局和已登记入口。新安装须首次运行或显式 register 后才能从 dsh 发现。
- 不同 profile 须显式配置不同 profileId（Windows 文件名不区分大小写）；相同 ID 共用同一接入凭证。未新增全局设置面板、聊天、语音、个人待办/提醒或工程派发，既有派发 gate 保持关闭。
- macOS/Linux 未在本机验证，原生管理入口本阶段仅支持 Windows。长期资源与异常驱动恢复不由本轮短时观察代替。
