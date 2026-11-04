# 人物轮廓交互与下方控制条（2026-11-04）

## 范围与实现

依据已确认的[设计记录](./2026-11-03-pet-interaction-design-review.md)及 architecture §3.1，实现人物轮廓与显示中的控件接收鼠标，其他透明区域放行到下层窗口。关闭原生窗口阴影；人物下方依次为本窗口文字草稿、明确未启用的语音按钮和下拉设置。没有新增对话、ASR 或任务派发入口。

- 当前视频/精灵图/兜底图片复用同一正在显示的媒体；128×128 alpha 采样生成 2 KiB 位图，每 80ms 检查，不创建第二个解码器。IPC 最多一个在途，待发送数据只保留最新值；不变地图约每秒续租。
- 原生每 16ms 按窗口当前位置和缩放换算光标，结合人物 alpha 和控件圆角决定整窗是否忽略光标。地图两秒失效后释放，包括过期的按下状态；原生坐标读取失败放行并继续重试，状态不可用时给出提示。
- 按指针 ID 跟踪按下，释放、取消、失去捕获及失焦均清除；复用已有屏幕坐标拖拽与甩抛。卸载释放订阅、定时器、画布和拖拽处理器。
- Canvas 不可用时继续上传空人物轮廓与控件区域，并保留托盘“显示”订阅。原生每秒重播当前悬停状态，解决光标不动时快速重载丢失首次状态；前端仅在悬停值变化时重算显隐，避免重播阻止自动收起。

原生 API 语义参考 [Tauri WebviewWindow](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindow.html)，实际编译以仓库 Cargo.lock 为准。本实现是定时更新的命中近似，不承诺逐像素、零延迟的系统命中；快速跨越轮廓或移动后立即点击的时序仍需用户体验验收。

## 验证

- `pnpm -r build`、`pnpm -r typecheck` 通过；最终 `pnpm -r test` 共 **280 项通过**，两份本地动作包校验通过。
- 定向 `pet-interaction.test.ts / interaction-mask.test.ts / window-drag.test.ts` 共 **17 项通过**；包含慢 IPC 只发送最新地图、按指针释放/失去捕获、alpha 失败后恢复、Canvas 缺失保留控件恢复、卸载及订阅失败清理、原有九项拖拽行为。
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib interaction`：**3 项通过**，覆盖人物透明像素、控件圆角、按下保留、手动穿透与地图过期。新增原生文件 `rustfmt --check` 通过；整仓 `cargo fmt --check` 另有原有 `lib.rs` 两处格式差异，本轮未改无关格式。
- `pnpm --filter @maneki-pet/desktop tauri build --no-bundle` 通过。首次构建曾因旧 release 程序仍运行而失败；结束该程序后重建成功。
- Computer Use 检查真实 Windows 安装目录程序：人物周围没有矩形窗口阴影；点击人物回应、人物拖动/甩抛、透明留白处点击下层空白记事本、键盘聚焦、草稿输入/回车未发送提示、下拉设置和原有状态内容可用。光标保持在人物上 Ctrl+R，重载后控制条重新出现；离开人物/控件且失焦后控制条收起，重复 Hover 事件没有阻止隐藏。验证用空白记事本已关闭。
- 本机安装目录最初保留旧 Runtime bundle，造成配对失败；只读确认 `broker_tasks` 没有记录后备份并同步当前 bundle，重启服务。最终设置显示已连接、限额和勿扰状态；配对继续经 native 管理入口，未放宽鉴权或暴露根凭证。

## 本机交付与资源

已更新开始菜单快捷方式实际指向的 `%LOCALAPPDATA%\Programs\Maneki\maneki-desktop.exe`，同时同步其 `resources\maneki-runtime-bundle.js`；未重跑安装器。壳 SHA-256：`D65099627ECF7949EB1059EC7354AEC3D59FCE3B72F9C680D5FAA5FFB1B6461B`；Runtime bundle：`EA21D4CACD09F85B3EFAAD6051B75B3E75A6D5AD9882BF2B5F3DE17D3839BEE1`。旧文件分别备份为 `maneki-desktop.pre-interaction.exe` 与 `resources\maneki-runtime-bundle.pre-interaction.js`；用户数据库与配置保留。

无调试器的最终 release，在操作控制条和设置后，按壳及其全部后代、真实 Runtime 去重汇总 Private Bytes，九个进程 **265.89 MiB**，其中 Runtime **33.90 MiB**；页面重载后再次采样 **269.49 MiB**，Runtime **33.95 MiB**，均低于 300/75 MiB 预算。另一次同步 Runtime 前的采样为 245.79 MiB，不混用为最终版本对照。短时采样不证明长期峰值、GPU 显存或所有工作负载；CPU 采样夹有页面重载，不作为空闲 CPU 基线。

## Standards

以 `21d4558` 为固定基线，对实现提交 `20efeaa` 的独立 Standards 审查未发现可操作的规范违规或代码异味。Shell 职责、中央 UI 文案、资源有界及无新增解码器约束保持。

## Spec

独立 Spec 审查发现两项 P2：重载时初始 Hover 丢失，以及 Canvas 缺失时托盘恢复不可操作。均已修复；Canvas 降级新增自动回归，重载在最终安装目录版实测，修复补丁复审通过。未发现范围扩张。

审查统计：Standards 0 项；Spec 初审 2 项 P2，均修复，复审未发现新问题。

## 尚未验收的边界

托盘手动整窗穿透/“显示”的完整人工流程、真实驱动下持续 Canvas/光标读取故障、混合 DPI 与多屏、长时间资源稳定性、事件到动画 p95 和新安装器流程未在本轮完成。macOS/Linux 未在本机验证。现有 dsh 实际任务闭环与安全 gate 不因本次窗口交互改动而通过；M1/M2 整体出口保持未勾选。
