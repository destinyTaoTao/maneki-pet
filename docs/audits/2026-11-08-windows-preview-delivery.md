# Windows dsh 个人助理预览交付（2026-11-08）

关联 [#62](https://github.com/destinyTaoTao/maneki-pet/issues/62)。基线 `main@7dd8228`，设计先行提交 `0de2b75`、`68781d7`；范围为把已有个人助理交付为 Windows x64 可安装预览，不开放工程派发、第二宿主、自动收费调用或新权限。用户要求保留人工验收项，未替换用户生产安装或读取真实用户数据库。

## 交付结果

- 桌面 / Runtime 同版本 `0.2.0-alpha.1`，dsh 插件仍为 `0.3.0`，宿主仅验证 `0.2.1-rc.5`。当前用户 NSIS 安装器包含 Node 24.12.0 x64、Runtime、正式橘猫娘 1.1.0 及第三方许可；不包含模型、录音、密钥或数据库。未签名、未上传 GitHub Release，不提供本轮 MSI。
- `pnpm release:windows` 从已批准本地素材构建，运行全仓构建/测试/类型检查及原生 NSIS 构建，输出版本化 `dist/releases/maneki-0.2.0-alpha.1-windows-x64`，包含安装器、插件 tgz、中文说明、语音记录、源提交清单与 SHA256SUMS。不覆盖已有交付目录。素材缺失/占位/损坏或版本不一致即拒绝；普通开发构建的占位行为未改。
- 固定 Tauri CLI 2.12.4，随仓库保留对应官方 NSIS 模板与 MIT 许可。仅用安装 hooks 不足以阻止旧卸载器先运行，因此在 `.onInit` 前置文件占用检查，再在文件替换与卸载前检查；移除上游可能终止进程的检查，避免两次检查之间新启动的程序被强杀。运行中返回 32；旧 MSI 自动迁移被阻止。来源与修改点见 `apps/desktop/src-tauri/installer/README.md`。
- 安装完成仅登记 dsh 固定入口，不自动启动/配对。卸载仅注销 executable 匹配本安装的登记，默认保留历史、待办、提醒、配置与凭证。新增 unregister CLI 不改 HTTP protocolVersion 或 SQLite v6。管理入口在 HMAC 身份校验之后、发送凭证之前检查精确发行版本；旧后台明确报错，先用旧版退出并同步更新。

## 自动运行证据

`pnpm acceptance:windows` 构建独立产品名、二进制名、bundle ID / 卸载注册表身份，APPDATA / DSH_HOME 隔离，安装路径含中文和空格。`repeat` 复用同一隔离安装包、使用新数据目录；`finish` 仅关闭/停止测试实例并静默卸载，数据库仍保留。脚本校验临时目录和标记路径，禁止将标记指向生产安装；不代批原生安全确认。

最终复验实例 `Maneki Acceptance e02ea1ad`，证据保留于临时目录 `maneki-install-acceptance-Ouv9ws/evidence.json`；此前 `dd808c08` 的重复验证与原生页签观察留于 `maneki-install-acceptance-RUJA2I`（具体系统绝对路径不入仓库）。均已卸载测试程序、保留测试数据。已通过：

1. 实际静默初装、自动入口登记，安装资源和 Node 许可齐全；打包 sidecar 可独立创建/复用个人助手凭证。未借用系统 Node 启动 Runtime。
2. 原生 connect 未配对返回 pairing_required，不替用户授予 express。模型、自身云端与麦克风默认关闭；正式个人 HTTP 入口通过规则式文字创建待办及未来 24 小时提醒，不实际触发通知或收费调用。
3. Runtime 运行时安装和卸载返回 32，sidecar 哈希不变，后台仍正常；没有强制结束桌宠、Runtime 或 dsh。
4. 测试实例停止后覆盖升级，重连复用凭证，待办/提醒 ID 保留。SQLite 通过测试夹具回到 v5 形态，升级到 v6 生成 `.bak-5` 并保留内容。
5. 升级用的是**当前源码、旧 0.1.9 安装元数据**，用于验证 NSIS 升级路径；不是历史 0.1.x 真实二进制或旧 MSI，不能据此声称真实既有用户迁移已验收。
6. 实际 dsh `0.2.1-rc.5` 在隔离 DSH_HOME 安装本地 `0.3.0` tgz；通过真实宿主命令注册表调用 `/maneki status` 处理器，recordInput=false，状态为正在运行。退出测试宿主后 Runtime 保留；没有运行模型任务或原生配对同意。
7. 独立安装的真实原生助手窗口已观察：聊天显示测试待办记录，提醒页显示待投递测试项，设置页展示默认关闭模型/云端/语音；仅切换页签，未修改隐私或授权。自动启动的独立视图也确认存在。
8. 关闭测试视图、停止测试后台后实际卸载；主程序、sidecar 与本安装登记已移除，卸载前后数据库 SHA-256 一致。视图关闭 IPC 早于文件句柄释放时，验收脚本只对未改文件的退出码 32 作有界等待；不强杀。

`pnpm -r build`、`pnpm -r test`、`pnpm -r typecheck` 均通过：352 项测试通过，2 项设备测试默认跳过（Core 96、Runtime 127、Desktop 83、dsh 插件 7、dsh Adapter 22、platform-core 8、B站 5、CLI 4）。`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` 的 6 项 Rust 测试及 fmt 检查通过。新增回归覆盖已通过身份核验但发行版本过旧时拒绝个人凭证创建，以及注销入口的安装路径归属；已批准实际素材的发行前置验证通过。Windows NSIS 构建已通过，最终交付目录另由干净源码提交执行发行命令生成并核对清单。

曾遇到整条验收等待较长，最小 native / helper 往返与带阶段日志复测通过，未复现可确认的生产缺陷；未将猜测记为修复成果。

发行命令复跑捕获 HTTP 健康测试一次 `fetch failed / bad port`，流程立即停止、未交付失败产物。最小复现中同一个 127.0.0.1:6000 服务原生 Node HTTP 返回 200，而 fetch 在连接前返回 bad port；HTTP 测试使用 OS 分配的随机端口，与正式固定 18100 不同。测试夹具现仅在该明确错误时停止该实例并有界重选端口，其他启动、网络错误及业务断言继续失败；不增加测试重试、不修改正式端口或安全策略。

## 本机交付封存

`pnpm release:windows` 最终完整通过，重新执行全仓构建、352 项测试（2 项设备跳过）、类型检查、正式生产身份 Windows NSIS 构建及 dsh tgz 打包。交付目录为 `dist/releases/maneki-0.2.0-alpha.1-windows-x64`，`release.json` 记录源码 `701eea94e88fc65f024e8713cb83c631845b3027`、dirty=false、Node v24.12.0。此后仅追加本段审计证据，不反写已封存产物。

生产安装器 `Maneki_0.2.0-alpha.1_x64-setup.exe` 为 56,574,107 字节（约 53.95 MiB），PE ProductName / ProductVersion 为 Maneki / 0.2.0-alpha.1，SHA-256 为 `5027266caef9f9c806493ec6b06ffab78feb1fa00cd6c4f216ec1c3cb68c6204`。独立复核 10 个交付文件的大小/哈希及包含清单自身的 11 条 SHA256SUMS 均通过；随包本地 Markdown 链接和 tgz 内容检查通过。安装产物保留本机，不入 Git、不自动上传公开 Release；用户原生产安装未替换。

## 人工与平台边界

以下仍保留，不以隔离脚本或底层 API 代替：

- 生产身份交互安装、来源 / SmartScreen、缺失 WebView2 的联网安装、真实旧 MSI 或用户旧安装升级、显式删除数据与通知身份清理。
- `human-acceptance` profile 的原生配对同意/拒绝、真实托盘退出确认及其他原生授权操作。
- 真实麦克风/扬声器、设备切换/权限/噪声、ASR 准确率、本地模型规模；真实对话/百炼账号权限、费用与延迟。
- OS 通知可见性、真实休眠/恢复/时钟变化、多屏/DPI、长时间稳定性与性能 p95 / 完整进程树资源。
- macOS/Linux 未在本机验证；本轮只交付 Windows x64，不证明 M1/M2/M3/M4 整阶段出口或反向工程派发闭环通过。

安装、升级、回退和配置步骤见 [Windows 指南](../install-windows.md)及[语音指南](../voice.md)。安装器依据 [Tauri 官方 Windows 安装说明](https://v2.tauri.app/distribute/windows-installer/)、[官方配置](https://v2.tauri.app/reference/config/)和[对应固定版本模板](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)。

## 2026-11-22 · 当前源码隔离安装复验

Windows 11 x64、Node 24.12.0、pnpm 12.16.1、dsh 0.2.2-rc.1。旧验收脚本在安装后才检查旧 dsh 版本，并把原生 `pnpm-native.exe` 当 JS 加载。现提前使用插件声明检查 dsh 版本，原生 pnpm 直接启动，发行脚本复用同一调用规则。dsh 验收 profile 只装配会话与命令服务，使用独立目录及环境白名单。

实际 NSIS 初次安装、固定入口注册、打包 Runtime 文字助手、运行中拒绝覆盖/卸载、升级与 v5 → v6 迁移、真实 dsh tgz 安装与命令注册、宿主退出后后台继续运行、卸载保留数据库均通过。失败轮遗留锁文件，经原生排他锁确认无人持有后回收，随后卸载并核对数据库哈希。升级夹具仍使用当前源码配 `0.1.9` 版本元数据。源码构建来自带独立 EverNook 未提交改动的本地工作区，本轮验证范围为安装、入口与个人事项。

复验使用独立 `MANEKI_WINDOWS_ACCEPTANCE_RECORD` 路径，先运行 `corepack pnpm acceptance:windows prepare --headless`，接着运行 `corepack pnpm acceptance:windows finish`。已有同版夹具可使用 `repeat --headless`。本轮未打开助手窗口、替换生产安装或更新封存安装包，原生确认、焦点和真实旧版迁移继续单独验收。[验收脚本](../../scripts/acceptance-windows.mjs)
