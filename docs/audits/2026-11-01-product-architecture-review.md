# Maneki 产品目标、架构与实现审计（2026-11-01）

## 基线与结论

代码基线：`c55c3ed`，审计开始时工作区干净。覆盖根文档、Core、Runtime、桌面/Tauri、dsh、平台扩展和 EverNook shim；参考来源为当次读取的官方文档与 GitHub 上游。审计中未修改业务代码、未登录平台、未派发付费真实任务。

**结论：保留共享 Runtime + 纯 Core + 分能力 Adapter 的整体结构，优先修复执行闭环，当前不具备可声明为安全可靠的完整个人助理的证据。** 本项目的长期产品是独立身份和主会话的个人助理，桌宠/虚拟伴侣是交互形态，harness 插件是入口，harness 是工程执行者。把跨会话调度和恢复做可靠，比继续增加动作、技能包或平台接口更接近首版价值。

现有实现明显超过文档首页原先的“M1 原生尚未编译”，但也明显少于架构目标。文档已补齐不少正确不变量，关键问题在于部分实现没有执行这些不变量；不能靠放宽设计把问题追认为已通过。

本轮依据用户点名的 grill-with-docs，使用 grilling 与 domain-modeling，进行了两轮问题和最终共同理解确认。架构规范以 [architecture.md](../architecture.md) 为准；本报告是指定基线的证据，不是第二份规范。后续代码行号变化时仍应以该基线复查。

## 用户已确认的决策

| 问题 | 确认结论 | 文档落位 |
|---|---|---|
| Q1 主会话归属 | Maneki 独立拥有助理身份、主会话和个人上下文；harness 执行具体工程任务 | architecture §4.2、ADR-0003 |
| Q2 首版会话边界 | 保留 dsh 新建受控任务优先，已有会话先观察；pi 随后 | roadmap M2b/M5 |
| Q3 平台发布目标 | 未来支持预览、逐次确认、官方授权通道发布和回执对账；无人值守另议 | architecture §10.2、ADR-0004 |
| Q4 忙碌会话介入 | 默认排队或用户选择的指导，明确要求才打断；取消未确认保持未知 | architecture §5.1 |
| Q5 可插拔方式 | 各能力分别建契约，显式注册、可替换/禁用；不要求万能插件接口 | architecture §4.5 |
| Q6 共同理解 | 上述方向定案，本轮审计并同步设计文档，不修改业务代码 | 本报告及同步文档 |

新术语记入根 GLOSSARY，重大取舍分别记录 ADR。ADR-0002 的人工发布长期边界被部分取代，历史记录保留；EverNook 仓库/spec 本轮未修改。

## 产品目标与真实能力

| 能力 | 设计目标 | 基线实际状态 |
|---|---|---|
| 桌宠/换装 | 不依赖模型的表现层，多 Shell 共享助理 | 双动作包、视频/精灵图、点击和窗口代码已有；M1 出口未完成 |
| 独立主会话 | 身份、个人上下文、持久历史与意图分流 | 只有 ChatProvider 类型、预算/上下文组件；没有完整对话入口和编排服务 |
| dsh 任务中间人 | 授权→派发→审批→状态→输入/取消→恢复→交付 | 有 Broker、HTTP API、网关客户端；状态推进、授权和恢复存在 P1 缺口 |
| dsh 插件 | 无桌宠窗口也能使用共享 Runtime | 尚无 `apps/dsh-plugin` 实现，不能把桌面接线等同于插件交付 |
| pi/其他 harness | 复用契约，按宿主版本登记能力 | 尚无 pi Adapter；不能从有通用接口推导已完成适配 |
| 会话总览/介入 | 跨来源发现、选择、回答、未来排队/指导/打断 | 有契约示意，无完整产品入口；dsh continueSession 声明与实现不一致 |
| 语音 | ASR/TTS 独立、文字优先、多端设备租约 | 未实现完整采集、识别、播报和租约链；尚无语音设备验收 |
| 生活助理 | 持久提醒、休眠恢复、简报、低打扰建议 | Core 有主动规则/简报组件；没有完整提醒仓储、调度与 OS 投递闭环。日历数据连接也未实现 |
| 平台运营 | 当前备料；未来按授权确认实际发布 | 有 B站备料/导出/人工回执 CLI；没有抖音发布或账号维护能力 |
| 外挂记忆 | 故障可降级、读取/写回独立授权 | 有 MCP 客户端和 Python shim；两条接入路径尚未组成独立主会话的端到端链 |

“所有工作会话”只能是已接入、能访问且有授权的宿主会话集合；会话发现、读历史、离线续接、给活跃进程发消息和接管控制不能混称支持。个人身份/记忆可长期持续，工程工作区和项目指令仍应隔离到任务上下文。

## 质量属性判断

| 属性 | 设计判断 | 实现与优化重点 |
|---|---|---|
| 性能 | 本地单用户场景适合现有栈；无需分布式系统 | 未证明目标负载下的 p95；历史内存余量小；同步全量任务扫描、按条数缓存、WS 无背压影响长期运行 |
| 扩展性 | Core 端口、宿主 Adapter、Provider 拆分方向合理 | Runtime 直接导入 dsh、TaskService 依赖 DshAdapter；第二宿主落地时再提取最小注册/选择边界，先用替身证明可替换 |
| 可维护性 | strict、workspace、纯规则与 IO 分离已有收益 | 测试集中验证组件，缺真实生命周期拼接；规范/代码/README 漂移；Python 扩展环境未纳入 pnpm 验证 |
| 可插拔 | 能力分契约优于万能插件框架 | Provider 类型存在不代表已可装配；当前不支持任意第三方代码热插拔，也不应提前承诺 |
| 可配置 | 有 schemaVersion、未知字段拒绝和少量限额配置 | 没有完整 Provider/音频/记忆读写/会话范围设置；dsh token 明文配置、目的地硬编码，需要凭证引用和实际端点确认 |
| 安全 | 回环、scope、默认 ask、原生审批等设计规则合理 | scope 错用、WS 崩溃/撤销缺口、无当次派发授权；安全边界尚未落实 |
| 可靠性 | 持久化、未知结果先对账、确认后取消的规范正确 | 核心实现与这些规则相反；当前不能声称“不丢任务、不重复执行、正确取消与恢复” |

这里的扩展性重点是新增 harness/能力的修改范围与资源可控，不是多租户或集群吞吐。单用户桌面助理优先可靠状态机、受控并发和可诊断性。

## P1：发布前必须修复的实现问题

### F1 未鉴权 WS 输入可以终止 Runtime

- 证据：`packages/runtime/src/ws.ts:103-120`，JSON.parse 后直接读取 message.ticket，未验证非 null 对象。
- 触发：新建 `/v1/events` 连接，首条文本帧发送 `null`，无需 token。
- 独立进程复现：退出码 1，`TypeError: Cannot read properties of null (reading 'ticket')`。
- 影响：未授权本机连接可令整个助理失效，不只是当前连接失败。
- 最小修复：严格协议消息校验，将异常限制在连接内；用成熟 WS 实现处理帧解析、连接错误、消息大小与背压，保留应用层鉴权策略。

相关边界：`ws.ts:34-46` upgrade 不查 Host/Origin；`auth.ts:61-77` 票据仅绑定到期时间；`ws.ts:120` 所有连接身份固定 ticket-holder。客户端撤销没有关闭既有连接、作废其票据或按来源过滤广播。HTTP 的正确校验没有自动覆盖 upgrade 路径。

### F2 表达凭证可派发、查询和取消任务，缺默认 ask 的授权链

- 证据：`packages/runtime/src/http-api.ts:270/301/319` 任务入口检查 express，而配对可发 tasks；`:285-286` 不带客户端身份直接 submit。
- 实际 HTTP 复现：express token 提交得到 202；tasks token 得到 403 `task dispatch requires express scope`。
- 影响：本应只有表达能力的来源获得执行权限；当次确认、目标授权和任务归属没有在服务端落实。修改勿扰也使用 express，权限面同样需要收敛。
- 最小修复：分离表达/任务/设置 scope，绑定受信客户端与可操作任务；默认 ask 的授权必须与不可变请求、项目、宿主绑定并持久化，再允许 dispatch，不能只加 UI 弹窗。

### F3 派发后丢 TaskRef，完成不推进队列，重启无法对账

- 证据：`packages/runtime/src/runtime.ts:104-107` 丢弃 submit 返回值；`packages/core/src/task-broker.ts:105` sessionId 初始空串；`task-service.ts:29-36` 查询仅附加网关快照，不更新 Broker。
- 组合复现：顶层 `running, sessionId:""`，嵌套 gatewaySnapshot 已 `completed, sessionId:"s-1"`，第二单仍 queued。
- `dsh-adapter.ts:87/132/140-142` 映射仅内存。新 Adapter 查询旧 brokerRequestId 返回 not_found；Runtime 没有启动恢复和终态驱动。
- 影响：结果不能可靠回传、队列卡住、取消缺正确目标、重启后任务失联。
- 最小修复：持久化下游 TaskRef/提交阶段，接通事件或受控轮询；快照对账后更新 Broker、保存交付、推进队列。重启先恢复映射和未知任务，不能简单重发。

### F4 取消失败或仅受理仍标已取消，释放项目执行槽

- 证据：`task-service.ts:45-55` 捕获 adapter.cancel 失败后无条件 notifySettled(cancelled)；`dsh-adapter.ts:177-179` 收到 cancelSession 返回即设 cancelled。
- 复现：cancel 抛 gateway offline，接口仍返回 cancelled，第二单进入 running，派发记录 `[br-one, br-two]`。
- 影响：用户被误导，原任务可能继续写文件，新任务同时修改同一工作区。
- 最小修复：区分取消请求受理、待确认与已停止；失败/未知不释放执行槽，经宿主状态确认后才进入 cancelled。队列中尚未提交的任务与运行中任务分别处理。

### F5 提交回执丢失被当作失败，允许同项目第二单启动

- 证据：`task-broker.ts:114-116/162-168` 任何派发异常均标 failed 并推进下一单。
- 故障替身复现：模拟宿主已接收、回执超时，得到 `a:failed, b:running, dispatched:[br-a,br-b]`。
- 影响：未知执行被误报失败，破坏同项目串行，也诱导用户重复提交。
- 最小修复：区分确定未提交与结果未知；未知时保留项目占用并先 query，对账前不重试、不释放。请求超时、取消信号和业务终态必须分别表达。

### F6 幂等键没有客户端作用域

- 证据：`task-broker.ts:81/96` 全局按 clientRequestId 查找，brokerRequestId 直接为 `br-${clientRequestId}`；HTTP 没传 trustedClientId。
- 触发：两个 Shell 各自使用 requestId=1，同内容会混成一单，不同内容被冲突拒绝；已复现异内容拒绝。
- 影响：多入口隔离与可追踪性不成立；可猜 ID 的任务读取消入口也没有客户端归属判断。
- 最小修复：数据库以 `(trustedClientId, clientRequestId)` 唯一认领，独立分配全局 brokerRequestId；跨客户端相同 ID 必须有独立测试。

### F7 可选记忆进程启动失败会拖垮助理

- 证据：`packages/runtime/src/mcp-memory-client.ts:144-173` spawn 没有 error handler。
- 独立进程复现：配置不存在的 executable 并 retrieve，即使调用方 try/catch 仍 exit 1，`Unhandled 'error' event / ENOENT`。
- 最小修复：覆盖子进程及 stdin 的 error/exit，终结所有 pending 请求并返回可诊断降级；外挂故障不能影响文字任务。

### F8 发布 gate 与能力声明未执行

- `dsh-adapter.ts:63` 仅 query=status_only；`runtime.ts:93` 只凭 dsh 配置存在便装配执行，没有落实 architecture §5.1 要求的 full 恢复和原生审批验收 gate。
- `dsh-adapter.ts:59/109-110` 声明 events 但 subscribe 是空函数；`:61/117-118` 声明 continueSession 却拒绝 existing target。
- 历史 spike 证明普通文本网关派发、headless 越界 fail-closed 等局部事实，不能单独证明 web 新会话中的危险删除被阻塞、审批 UI 可到达、拒绝确实阻止、等待无人响应不放行。
- 最小修复：能力登记绑定宿主版本与真实证据；未满足执行 gate 则观察/明确受限，不把方法存在或字段为 native 当作已验收。工作区内自动删除与项目要求的危险操作逐次确认也须实测对齐。

## 其他缺陷、潜在风险与最小优化

| 编号/等级 | 代码证据与触发 | 影响与建议 |
|---|---|---|
| F9 P2 项目身份 | `task-broker.ts:176` 比较原始 workdir；Windows 的 `C:\proj`、`C:\proj\.`、`C:/proj` 被同时派发三单 | Runtime 先确认真实目录，处理大小写/junction 并产出统一项目身份；路径绑定仍不是文件沙箱 |
| F10 P1 功能断链 | `apps/desktop/src/main.ts:293-308` 没处理 expression.say/state/play；Runtime 发布这些事件 | MCP 成功返回后桌宠不说话/切状态/播动作；补真实事件到播放器集成验证 |
| F11 P2 媒体与资源 | `scripts/lib/pack-fs.mjs:64-68/87-88` 只比 hash/bytes，按实际 stat.size 先分配 Buffer | 已复现把普通文本伪装 PNG、配合法哈希即可安装；切换前验证真实格式/尺寸，读取前拒绝实际超限或清单不符 |
| F12 P2 不可信上下文 | `packages/core/src/memory-context-assembly.ts:35` 将记忆直接放 system；`context-window.ts:101` 把生成摘要放 system | 记忆/摘要不能提升为高优先级指令。当前没有接通真实主会话，未声称已造成越权；接线前以低信任上下文承载来源、分隔内容，并确保授权规则在模型外 |
| F13 P2 写入盲重试 | `mcp-memory-client.ts:152-166` 进程退出自动重试所有 pending，write 不带持久化幂等键 | 写入成功但回执前退出可重复写记忆；读可有界重试，写须经稳定键/查询证明可重试。当前未用真实服务复现重复写，结论是明确的协议风险 |
| F14 P2 凭证/配置 | `runtime-client.ts:91` 通过 native read_root_token 把 root 交给 WebView；`quota.ts:17-20/114-133` dsh token 明文且 baseUrl 可变；Adapter dataBoundary 硬编码 DeepSeek | native 侧完成配对，仅返回最小 scope token；密钥用安全引用；按实际端点展示数据目的地和独立授权。没有声称已证明 root 可被独立漏洞窃取 |
| F15 P2 UI 一致性 | `main.ts:300-302` 未同步托盘；`runtime-client.ts:110-116/212` 不检查写勿扰的 HTTP 状态且吞错误 | 托盘显示与实际门控可能不同；成功回执/事件驱动同步，失败回滚并展示 |
| F16 P2 拖拽 | `window-drag.ts:85-89` 用 client 坐标差计算绝对窗口位置 | 窗口移动会改变 client 坐标；改用一致的屏幕坐标系并做真实拖拽验收 |

WS/CSP 为静态待验证项：`tauri.conf.json:30` 只列 http://127.0.0.1:18100，客户端用 ws:// 同端口；应显式列出所需 WS 源并做 release 事件显示验收。本轮没有复现 release CSP 拒绝，不能写成已确认运行缺陷。

性能方面：`player.ts:25-28` 按 64 条资源缓存而非字节，单包可达 256MiB；`RuntimeStore.allBrokerTasks`（store.ts:222 起）和 Broker 热路径反复读取全部历史任务，随历史积累同步阻塞事件循环；项目有界不等于全局并发有界。建议先限制缓存字节/媒体规格、任务全局并发和请求/连接输入，使用带索引的定向任务查询；测得瓶颈前不引入消息总线、集群或数据库替换。

历史进程树 Private Bytes：Runtime 61.5MB + Shell 树 182.2MB ≈ 243.7MB，距 250MB 预算仅约 6.3MB。本轮没有重新测内存；原 README 的 29MB 是较小统计范围、150MB 是旧预算，已同步修正。没有事件到首帧 p95、洪泛背压或大素材场景的新证据。

当前实际为 Windows 实现：native launcher 固定 exe、打包脚本固定 Windows target；macOS/Linux 未在本机验证，仍需各自打包、透明媒体、Origin、后台生命周期、通知与音频验收。

## 参考项目与可借鉴模式

参考是设计对照，不是成熟度或安全性背书；本轮没有运行这些项目。上游最新 API 也不自动适用于本机旧版本。

| 项目/官方资料 | 证据与对 Maneki 的建议 |
|---|---|
| [dsh Agent 契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent/README.md)、[Session](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/session/README.md)、[CLI SDK/ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md) | 官方有 Agent 创建/恢复/发现、会话与指导/取消接口。后续比较公共 SDK/ACP 与当前 web 内部线协议的稳定性，按固定版本验证后再迁移。其 [SAFETY](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md) 明示未审计，不能当生产安全保证 |
| [pi SDK](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)、[RPC](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md)、[会话示例](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/sdk/11-sessions.ts)、[安全声明](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/security.md) | 适合受控 RPC 子进程与独立任务会话；列表/打开会话文件不保证接管另一个运行中 TUI。prompt 受理不等于完成，需按宿主最终 settled 语义取结果；扩展/子进程权限也不是沙箱。先验证原生审批是否满足要求，不擅自把第二目标替换成别的 harness |
| [OpenClaw 会话工具](https://docs.openclaw.ai/concepts/session-tool)、[ACP](https://docs.openclaw.ai/tools/acp-agents)、[审批](https://docs.openclaw.ai/tools/exec-approvals)、[调度](https://docs.openclaw.ai/automation/cron-jobs) | 借鉴独立主会话→隔离工作会话→结果回传、工具可见范围与审批。ACP、自身子任务与 CLI 模型后端是不同接入方式，不据此承诺支持任意 CLI；不必照搬整个多渠道平台 |
| [AIRI](https://github.com/moeru-ai/airi)、[语音分层 ADR](https://github.com/moeru-ai/airi/blob/main/docs/ai/adr/2026-10-16-voice-input-layers.md) | 借鉴角色表现、语音输入与说话模块分离、设备生命周期；官方仍有早期开发边界，不把伴侣形象能力等同于可靠 Task Broker |
| [Letta 身份](https://docs.letta.com/concepts/stateful-agents)、[多对话](https://docs.letta.com/concepts/conversations)、[共享记忆](https://docs.letta.com/concepts/shared-memory) | 借鉴持久身份与分开的任务上下文，跨会话记忆不等于跨会话权限。无需引入其云存储，现有 SQLite/可选外挂记忆可承载本项目边界 |

语音可进一步对照 [LiveKit 轮次与打断](https://docs.livekit.io/agents/logic/turns/tuning/)，只借鉴端点检测/播放打断，不让实时语音循环承担长任务事实状态。

用户类比产品，本轮按 [Meta Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)、[Manus Cue](https://cue.im/)、[xAI Grok Bot](https://docs.x.ai/grok-bot/overview) 理解：共同产品形态是持续身份、可委派工作与主动回访。它们不等于开放的跨 harness 协议，也不证明本地实现、权限与恢复可直接照搬；若用户所指为其他同名产品，具体体验对照需另补准确链接，不影响已确认的产品边界。

抖音当前官方[创建视频](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/create-video/video-create)公开文档列出 `POST https://open.douyin.com/api/douyin/v1/video/create_video/`、scope `video.create.bind`、权限申请和用户授权；创建后仍有审核。它证明存在有条件的官方通道，不证明个人主体或本用户账号能获批。先核实资质再设计接入，不沿用旧接口名称、永久禁止的笼统历史判断，也不通过模拟协议绕过未获批能力。

MCP 记忆客户端当前手写 JSON-RPC/子进程管理，而项目已经依赖官方 SDK。建议复用对应锁定版本的 [官方 TypeScript Client/Transport](https://github.com/modelcontextprotocol/typescript-sdk)，保留记忆工具语义适配，不重复维护协议握手、取消与关闭；升级须测试，不能直接复制与锁定版本不同的最新示例。

## 最小落地顺序与验收

1. **封闭执行入口的权限与协议故障**：F1/F2/F7，验证 null/错误帧不杀进程、表达凭证不能做任务、记忆缺依赖只降级、撤销立即生效。
2. **完成一个真实 dsh 文字闭环**：F3–F6/F8/F9。受信 UI 选择真实项目并确认，保存全局请求与 TaskRef；完成驱动队列；拒绝危险操作确实不执行；断线/运行中重启后能恢复原任务和结果。
3. **完成桌面表达与最小 dsh 插件**：F10、release WS/CSP、无窗口连接/启动/退出与多端勿扰一致性；关闭任一客户端不丢后台事实。
4. **增加独立主会话及 pi**：先文字对话与最小持久历史，意图用受限结构校验进入 Broker；用第二 Adapter 检验替换边界。不要先建设通用 planner、插件市场或工作流 DSL。
5. **再加语音、可靠提醒和平台发布**：语音是输入/输出通道，提醒由确定性调度拥有事实；发布是授权副作用，必须独立验证平台资质、逐次确认与回执对账。

核心故障验收至少包括：两个客户端相同入口 ID、两个路径别名、受理后回执丢失、cancel 受理后宿主未停、完成先于查询/订阅衔接、Runtime 运行中重启、拒绝/无人响应的真实危险操作、外部记忆故障。测试应断言最终行为与外部副作用，不能仅接受 running/completed 任意一种结果。

## 本轮验证与边界

- `pnpm -r build`：通过，含桌面前端构建与内置素材生成；不等于 Tauri Rust/安装器新一轮编译。
- `pnpm -r test`：205 条通过（Core 91、dsh 21、desktop 24、platform-core 8、platform-bilibili 5、Runtime 54、CLI 2）；动作包检查 2 个通过。
- `pnpm -r typecheck`：通过。
- 文档验证：9 份文档的 29 个本地链接均存在，代码围栏成对、无冲突标记，`git diff --check` 通过。
- 现有 `C:\maneki-lab\venv-py314` 运行 `packages/adapters/evernook/tests`：6 条通过。没有重新运行需要用户配对配置的独立 conformance CLI，历史验收与本轮测试不混计。
- 独立最小复现：WS null 进程退出、记忆 executable 缺失进程退出、express/tasks HTTP 权限反转、完成快照未推进 Broker、取消失败释放队列、提交超时释放队列、路径别名并行、Adapter 重建丢映射、非图片素材成功安装。临时素材已清理，未使用真实账号/付费任务。
- 测试全绿原因：`runtime/tests/tasks.test.ts:148` 接受 running 或 completed；重启测试先取消再重启，没有验证运行中对账；Broker 单测手工 notifySettled，没有证明 Runtime 接线；WS 未覆盖 null/来源/撤销；媒体测试没有真实格式拒绝。
- 未验证：新的 Windows 原生交互/安装/资源测量、macOS/Linux、真实 dsh 审批全链/故障恢复、pi 运行、麦克风/语音/休眠提醒、平台账号权限与真实发布。

本轮修正的是设计/文档漂移并记录代码缺陷，所有未修代码项仍保持未完成。后续处置按仓库 issue-tracker 流程建票；本轮没有向 GitHub 发布 Issue/评论，也没有把审计发现标成已修复。
