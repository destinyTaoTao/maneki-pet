# 模板碎碎念源码与隔离验证（2026-11-14）

基线 `d2e76fd`；后续实现及本记录位于 `codex/template-companionship` 分支。第一批 Core、Runtime、Desktop 已接线，不能据此宣称 Windows 实机验收或完整产品出口通过。

## 已验证

- Core：24条原创模板/6主题，确定性准入、两小时暖机和间隔、自然日及滚动24小时预算；覆盖夏令时回拨及时区别名。
- Runtime：assistant scope 和 WS 连接绑定，状态、租约、自动调度、手动点播、暂停和 ACK；候选发送前原子认领，失败或重启不补发；预算/偏好故障、回滚、健康变化及限频恢复有隔离测试。
- 聊天：引用来源和有效期校验、已提交请求重试优先、同事务保存、清历史/孤儿清理；损坏/未来格式原值保留并标示不可用，普通聊天和提醒不依赖引用读取；摘要恢复与旧页导航使用有界测试。
- Desktop：助手单一 WS、原生可见性探测、租约与重连、气泡优先级、勿扰、手动/暂停/关闭与回应草稿。双连接定向、丢弃确认、旧版本退化及语音/提醒仲裁由替身测试覆盖。
- 隔离真实回环 HTTP/WS + Desktop `CompanionClient` 跨包：单端自动投递、ACK、勿扰手动、引用聊天和幂等、发布失败后重启保守记账、旧 PUT 与 accepted 提醒保持。测试使用临时数据库拨前暖机时间，未覆盖真实 `main.ts` 原生窗口链路。
- `pnpm -r build`、`pnpm -r test`、`pnpm -r typecheck` 通过：525 项通过、2 项跳过；`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` 先前记录6项通过；`pnpm --filter @maneki-pet/desktop tauri build --no-bundle` 通过，产物为 `apps/desktop/src-tauri/target/release/maneki-desktop.exe`。未安装或替换用户程序。
- 独立只读评审覆盖协议/预算/健康、引用及桌面气泡。后续发现的历史标记和200条翻页改动分别经定向 Runtime 30 项、Desktop 17 项测试及只读复核；故障路径的红绿和修复细节见测试代码。
- 任务开始前已有素材许可证文件 SHA-256 为 `722303A6FB57F52AB738B3C9FF0F1D987543AF4DE4B3652095B74FA6DAF4EB06`，全仓测试后相同；`.playwright-cli/` 未纳入本任务。

## 未通过或未执行的验收

- **真实短休眠待验收**：已增加 Windows 系统挂起/恢复通知和进程内代数；气泡展示前在原生可见性查询前后检查代数，变化时先作废租约并重连。Windows 系统注册成功及模拟回调/异步竞态已测试，但用户选择暂不操作真实睡眠，尚无真实挂起/恢复或原生窗口端到端证据，不能勾选该出口。非 Windows 保留原有页面/时钟检测，尚未验证。
- 曾启动独立身份的 Windows 桌宠，初步看到设置入口并确认暂停写入独立数据库；发现暂停截止时间缺少界面反馈后已修复并通过自动测试，但用户按 Esc 停止桌面操作，修复后的实际界面未复测。窗口可见性、点击穿透、托盘恢复及语音/提醒并发未完成系统性实机验收；未做完整真实两小时暖机与间隔观察。模型、麦克风和通知的相关隔离测试不等于真实设备验收。
- 未测全进程树 ≤300 MiB、Runtime ≤75 MiB 或提醒调用 p95<1s；5万条普通历史零引用的孤立探测只是一组样本，不构成正式性能验收。macOS/Linux 未验证。
- 旧 Runtime 覆盖摘要恢复追踪字段且引用已在升级前恢复时，无法区分曾损坏与一直健康的引用，只能按600字符预算有损重建，不保证逐条送达模型；原始引用 KV 和历史仍保留。

因此调度和桌面源码链路有自动验证，但第一批整体验收尚未闭环。后续用隔离身份完成真实挂起恢复、窗口、两小时节奏和性能验收。

## Windows 电源通知修复补充

- Windows 使用 `PowerRegisterSuspendResumeNotification` 注册进程生命周期回调，挂起和恢复事件递增静态原子代数；注册失败时展示保守不可用。候选呈现前两次读取代数并检查原生可见性；读取倒序、失败或发现代数变化时先作废当前展示租约。非 Windows 保持原先检测方式。依据 [Microsoft PowerRegisterSuspendResumeNotification](https://learn.microsoft.com/en-us/windows/desktop/api/powerbase/nf-powerbase-powerregistersuspendresumenotification)。
- 新增短休眠模拟、原生读取乱序及可见性查询过程事件竞态测试；独立只读复核未发现可复现的重要缺陷。`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`：8 通过，1 个真实休眠测试按设计忽略；测试真实调用系统注册，但未触发真实睡眠。页面隐藏竞态修复前桌面定向24项通过，最终全仓含新增页面隐藏测试。
- 全仓 `pnpm -r build`、`pnpm -r test`、`pnpm -r typecheck` 通过：529项通过、2项跳过；`pnpm --filter @maneki-pet/desktop tauri build --no-bundle` 通过。素材许可证文件哈希保持不变。
- 机器报告支持 S3，但用户选择暂不操作系统休眠；未启动或替换用户安装。待用户愿意操作时可运行 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml observes_real_suspend_and_resume -- --ignored --nocapture --test-threads=1`，看到 `POWER_PROBE_READY` 后手动睡眠并唤醒；该探针只验证 Windows 回调，不等于验证实际桌宠旧租约、窗口操作或两小时节奏。

## 界面修复后的全仓与原生复验（2026-11-14）

本轮按用户要求不操作真实休眠，也不启动两小时观察。上轮独立窗口确认暂停写入后发现界面未显示截止时间；最后的界面修复在设置尚有未保存输入时保留输入并显示暂停截止时间，对应桌面回归测试通过；修复后的实际窗口尚未复测。

- `pnpm -r build`、`pnpm -r test`、`pnpm -r typecheck` 均通过：**530 项通过，3 项跳过**。跳过项分别为真实 Windows 通知、真实语音设备和手动启用的两小时暖机观察。
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`：**8 项通过、1 项忽略**；忽略项是需要人工操作系统休眠的电源通知探针。
- `pnpm --filter @maneki-pet/desktop tauri build --no-bundle` 通过，产物 `apps/desktop/src-tauri/target/release/maneki-desktop.exe`；未安装、替换用户程序或发布。
- 首次全仓测试中，`http-api.test.ts` 的跨重启测试因系统随机分配到 Fetch 禁用端口而报 `bad port`。核对后发现该文件两组真实 HTTP 跨重启测试仍直接使用随机端口；已切换到项目既有 `startFetchCompatibleRuntime` 夹具（仅为 Fetch 禁用端口重新分配，不重试业务断言），其夹具测试和 HTTP 测试共18项通过，随后全仓重跑通过。该修正只涉及测试，不改变产品服务端口或鉴权。
- 构建前后既有 `apps/desktop/public/packs/ASSET-LICENSE.txt` 的 SHA-256 均为 `722303A6FB57F52AB738B3C9FF0F1D987543AF4DE4B3652095B74FA6DAF4EB06`；保留已有 `.playwright-cli/`。

第一批出口仍未闭环：真实短休眠及旧租约失效、修复后原生窗口/命中与语音提醒交互、真实两小时暖机和间隔、内存及提醒 p95、macOS/Linux 均待各自验证。

## 2026-11-22 · 两小时真实墙钟暖机

在 `1015966` 工作区基线运行 `MANEKI_REAL_WARMUP=1` 的 [Runtime 探针](../../packages/runtime/tests/companion-real-warmup.test.ts)。Windows x64、Node 24.12.0，使用临时 SQLite、真实回环 HTTP/WS 与桌面 `CompanionClient`。北京时间 14:53:47 开始，第一条自动台词在实际经过 **7,200,007 ms** 后到达。展示回调一次，持久预算认领一次，注入的通知器零调用。Vitest 退出码 0，单项通过。

本轮覆盖真实墙钟和连接上的首次自动表达。窗口可见性由测试回调给出，系统休眠、真正的桌宠呈现、首条之后的实时间隔与完整进程树预算仍保留。
