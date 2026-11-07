# 文字主会话、个人待办与单次提醒实现记录

日期：2026-11-07；分支：`feat/m1-catgirl-default`。前置设计提交 `e5e3c3b`，Windows 通知身份补充设计 `018038a`。本文记录局部交付，不代表 M1/M2/M3/M4 整阶段通过。

## 本轮实现

- dsh 插件 `0.3.0` 增加人类 `/maneki assistant`，通过原生固定入口打开同一个桌面 WebView 的对话、待办、提醒、设置面板；插件仍只持 express，不取得个人凭证。嵌入 dsh 设置页面后续另验。
- 独立 assistant scope、私有 WS 与 `assistant-client.json`。首次打开助手才创建，启动只复用已有凭证；撤销不重配。复用探针使用其已有权限的接口，没有为复用增加 express 权限。
- 主会话持久历史、分页读取、有界本地摘录、单轮模型调用、取消及重启不重放。清空预览绑定客户端、epoch、revision 与短期单次标识，删除消息及摘要，迟到回答和旧请求重发不能复活历史。
- 个人待办 CRUD、备注、完成状态、截止日期；单次独立或关联提醒、UTC 与原时区、明确命令及表单。截止日期不隐含提醒；同名或时间歧义先澄清；模型回答与 dsh 输出没有操作权。修改版本和客户端幂等键共用事务入口。
- 提醒 pending/sending/accepted/failed/cancelled 状态持久化，勿扰与预算阻塞时保留，恢复后合并原到期信息；认领与完成/删除串行，在途不承诺撤回。崩溃恢复复用持久化批次 ID，允许至少一次重投，不宣称 OS 严格一次或用户已看到。
- Runtime 保存时区、人设与模型配置；模型、自身云端能力默认关闭，不复制 dsh 密钥。兼容 Chat Completions 非流式端点，无工具、重定向、自动重试或云端回退。密钥仅保存用户目录私有文件引用，接口不回显。输入按 UTF-8 字节保守估算、输出硬上限、调用前额度预留，明确不是账单。

## 自动与设备验证

已运行全仓 `pnpm -r build`、`pnpm -r test`、`pnpm -r typecheck`；涉及包追加定向回归。Rust `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib` 的 5 项测试通过。原生发行构建使用 `pnpm --filter @maneki-pet/desktop tauri build --no-bundle`，没有用缺少生产协议特性的裸 cargo build 代替。

新增验证覆盖权限/私有 WS 隔离、凭证首次创建与正常重启复用、撤销不重配、日期与 DST 歧义、跨客户端幂等、旧版本冲突、清空后的迟到回复、Provider 忽略 abort 时退出不阻塞、v3→v4 备份、未完成聊天不重发、通知批次恢复、勿扰与关联取消。配置→服务→真实 HTTP Provider→历史的链路使用本机兼容服务替身，另测认证失败、重定向、超时/取消、响应上限、缺少用量和截断答案。所有模型请求均为本机替身，没有真实云端/计费调用。

实际 Windows 通知设备测试：设置 `MANEKI_TOAST_ACCEPTANCE=1` 后运行 `packages/runtime/tests/windows-notifier.test.ts`，覆盖全新 AUMID 的首次投递；测试使用独立身份并清理其元数据。普通测试跳过此项，避免打扰用户。设备测试通过，系统受理单次样本约 0.5s；这不是 p95 或用户已看到的证据。

原生验证使用 `%TEMP%/maneki-text-acceptance-*` 中相邻 exe/sidecar/bundle 发行布局及独立 APPDATA，没有替换用户安装程序或数据库。已观察首启连接、发送“待办：明天前提交验收报告”、正确截止日期及没有自动提醒、待办/提醒切页，以及 Runtime 重启后恢复历史。已通过原生输入创建一分钟提醒，具体时间在落库后反馈。

无窗口验证：创建“无窗口通知验收”（原定本地 16:33:05），关闭测试视图后 Runtime 健康接口仍可用；到期后重新打开助手，清单显示“系统已受理（不等于已看到）”。没有将此项等同于系统休眠/关机恢复或真实用户可见性验收。

短时资源采样：最终助手面板打开、两条已投递提醒、一个待办、无模型/调试器/语音，全相关进程树 Private Bytes 单次合计 278.73 MiB，其中 Runtime 35.71 MiB；关闭视图时 Runtime 约 34.95 MiB。符合此样本的 300/75 MiB 目标，不代表长期、其他素材、多屏或活跃模型峰值。

## 验收发现与修复

1. 提醒 INSERT 占位符数量不符，创建失败；事务集成测试覆盖修复。
2. 原生面板可能早于 Runtime 就绪，增加就绪等待与重新读取入口。
3. 新个人凭证没有 express，旧复用探针 `/v1/limits` 返回 403；改用 assistant 已有权限的设置接口，并补正常重启与撤销回归，没有扩权。
4. PowerShell 对可变 WinRT XML 节点隐式枚举失败，改用托管 DOM 的 InnerText 再交 WinRT LoadXml，文案始终为数据。
5. 非打包身份首次 Show 前读取 Setting 返回 `ELEMENT_NOT_FOUND`。登记本应用显示身份后由 Show 遵守 OS 策略调用，再核对权限；权限不可读或被阻止均明确失败。没有修改通知开关、OS 勿扰或安全/隐私策略，不借用其他应用身份。

接口依据：[Chat Completions](https://developers.openai.com/api/reference/resources/chat)、[Microsoft CreateToastNotifier](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotificationmanager.createtoastnotifier)、[桌面通知身份注册示例](https://github.com/WindowsNotifications/desktop-toasts/blob/master/CPP-WINRT/DesktopToastsCppWinRtApp/DesktopNotificationManagerCompat.cpp)。

## 迁移与边界

桌面、Runtime 和新插件一起更新。SQLite v3 升级前生成 `runtime.db.bak-3`；旧程序拒绝 v4，回退须停止后台并显式恢复备份。旧表达凭证不扩权，个人凭证撤销后不重新签发。Windows 文件私密性依赖用户目录 ACL，不宣称为加密凭证库。

仍未验收：真实云模型及其他兼容服务、真实休眠/时钟调整矩阵、长期资源与延迟 p95、多屏/DPI、安装器升级/卸载（含通知身份清理）、原生授权/退出确认按钮的人工点击、macOS/Linux。当前通知不处理点击激活，OS 受理不等于用户看见。语音、周期提醒、MCP `maneki_remind`、嵌入 dsh 设置页和工程派发未在本轮开放，继续按 roadmap 跟踪。
