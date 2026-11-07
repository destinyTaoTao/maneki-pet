# 可选百炼在线语音：实现与验证（2026-11-07，#60）

## 基线与范围

用户要求把此前开发合入主分支，再继续在线语音。仓库主分支实际为 `main`，没有 `master`；fetch 后确认 `origin/main` 是 `d142249` 的祖先，无分叉，已从 `583d4a0` 快进到 `d142249` 并推送。合入的是此前已通过全仓 330 项测试、类型检查和 Windows 原生构建的同一提交，不改写历史。已有 `.playwright-cli/` 未跟踪文件保留不入库。

本轮设计先行提交 `df81b44`，对应 [Issue #60](https://github.com/destinyTaoTao/maneki-pet/issues/60)。继续仅适配 dsh，复用 `/maneki assistant`、按键采集、主会话、个人待办/提醒和两步转写提交。不开放工程派发、操作审批、全双工、唤醒词或主动收费播报。不替换用户已安装应用，不修改用户真实隐私设置。

## 实现与数据边界

- ASR/TTS 可分别选择 local / bailian，默认仍是本地且关闭；可混用。北京地域、可选 Workspace ID 固定映射到官方 HTTPS 域名，不接受自由 endpoint。模型默认 `qwen3-asr-flash` / `qwen3-tts-flash`，音色 `Cherry`。
- 独立语音密钥用用户目录随机命名文件保存，HTTP 设置只回显是否配置；不读取/复用对话或 dsh 密钥。保存新密钥与 SQLite 配置失败时清理新文件、保留旧值；显式删除语音密钥不影响对话密钥。
- 云端选择、对应启用开关、全局自身云端授权、语音密钥缺一不可；ASR 还需麦克风开启。组件检测只读本地配置，不发账号探测或计费请求。设置说明上传录音/回复片段与可能费用，不作金额封顶承诺。
- ASR 只提交本次 WAV Data URI、模型和语言参数；无会话历史、项目上下文或工具列表。仅接收完整非空结果，依旧需有效 Shell 自动 submit 才变成业务操作。
- TTS 只发送当前回复最多前 150 字和独立在线音色。API 返回结果只下载固定北京官方 OSS 桶的 WAV；默认 HTTP 示例先升级到 HTTPS，不带 API Key、不跟随重定向、不允许任意主机/用户信息/端口。签名 URL 不写入数据库、不回显到 Shell 或日志。
- 上传、API 响应和下载共用取消信号/截止时间；全局云端关闭或设置变化取消正在进行的语音任务并隔离迟到结果。无自动重试、无本地/云端静默回退，错误只返回固定分类。
- ASR JSON 256 KiB、TTS JSON 64 KiB、WAV 2 MiB 上限；现有 30 秒录音、150 字播报与 PCM 校验不变。云端选项关闭时不引入常驻工作进程或加载本地模型，无新增依赖。
- SQLite 保持 v5，设置 schemaVersion 保持 1；旧配置缺字段默认本地，旧客户端保存缺新增字段时保留已有 provider / 在线配置 / 密钥。响应 `voice.apiKeyConfigured` 为只读标识，不能当成密钥或授权。

协议依据：2026-11-07 核验的 [Qwen-ASR 官方文档](https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference)及 [Qwen-TTS 官方文档](https://help.aliyun.com/zh/model-studio/qwen-tts-api)。Context7 当日额度不足，直接核对官方接口说明；没有使用第三方教程推断参数。只覆盖这两个 HTTP 协议，其他模型、地域或端到端接口不宣称兼容。

## 验证

新增 12 项自动测试（协议 6、Runtime 云端集成 5、桌面配置 1）：

1. 请求仅含本段音频/文字，语言自动模式不强行指定；ASR 截断/空结果拒绝。
2. API 认证错误、无效 JSON、响应超限均脱敏；无失败重试。
3. TTS 固定官方桶、HTTPS 升级、无 API Key 下载、重定向/恶意 URL/超限/假 WAV 拒绝。
4. 取消和超时覆盖 API、挂起响应流和 TTS 下载，故意忽略 abort 的迟到成功结果仍丢弃。
5. 关闭云端、缺密钥时 acquisition 拒绝；本地 TTS 租约仍可用；组件检测零联网。
6. 语音/对话密钥独立，设置响应不含值或引用，旧 payload 保存兼容，事务失败清理两类新密钥。
7. 真实 Runtime 链路接协议替身：识别后尚无待办，submit 后才创建同一业务事项；云端关闭后迟到识别不能创建消息/待办，TTS 下载取消保留文字。
8. 桌面设置分别保存 provider / Workspace / 模型 / 音色 / 独立语音密钥，检测显示“本地配置可用、未联网核验”，保存成功清空密码框。

全仓 `pnpm -r build` / `pnpm -r test` / `pnpm -r typecheck` 均通过；342 项测试通过、2 项设备测试默认跳过（Core 96、Runtime 118、Desktop 82、dsh 插件 7、dsh Adapter 22、platform-core 8、B站 5、CLI 4）。没有进行真实云端语音或计费调用，没有使用真实麦克风或播放扬声器。

`pnpm --filter @maneki-pet/desktop tauri build --no-bundle` 通过，生成 Windows release 桌面与 Runtime bundle；不打安装器、不替换已安装版。Rust 源码本轮未变，设备/原生授权人工项仍保留。

回退限制：SQLite 版本不变不代表旧 Runtime 能读取新增严格设置字段。更新前应停后台备份数据库；回退需恢复更新前备份，旧 v4 迁移备份不保证保留此后数据。不支持多个新旧 Runtime 混用同一用户目录。

## 继续保留的验收

- 真实百炼账号的模型权限、北京地域/Workspace 域名、音色、费用、音频 URL / WAV 格式、准确率和端到端延迟；协议替身通过不冒充云端实测。
- 原生麦克风权限/拒绝/占用、WebView2 采集、扬声器和回声、休眠/设备切换、冷启动与长期资源。
- 前序 human-acceptance 原生配对、退出确认、托盘和安装器/DPI/多显示器人工项继续保留。
- macOS/Linux 未在本机验证；需单独验证设备、播放与生命周期，Windows 本地实现也不能外推。

本轮按“实现与替身验证完成、真实账号/设备待验收”记录，不标记 M3 或整个产品出口完成。使用步骤见[语音说明](../voice.md)。
