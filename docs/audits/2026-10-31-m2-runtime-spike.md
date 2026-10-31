# M2 Runtime 底座 spike 与验收记录（2026-10-31）

## 范围

M2 首个纵向切片：`packages/runtime`（共享 Runtime 底座）的实现与本机可验证出口项证据。实现基线 [architecture v0.3 + 2026-10-31 选型记录](../architecture.md)，票据 #43/#44/#46 的 Runtime 层。

## 已验证（自动化测试 + 本机真机）

| 项 | 证据 |
|---|---|
| 生命周期/单实例锁、崩溃残锁回收 | `packages/runtime` 43 条测试（lifecycle/store/auth/http/ws/mcp/integration）全绿；`pnpm -r build && pnpm -r test` 全仓绿 |
| 无桌宠窗口启动 Runtime | 真机：`node dist/cli.js --config-dir <tmp>` 后台启动，`GET /v1/health` 返回 `{protocolVersion:1, instanceId, version}`（2026-10-31，pid 626） |
| 双入口不产生两个 Runtime/写入者 | 真机：第二实例启动被 `LockBusyError` 拒绝（lock held by pid 60980） |
| 缺 token/错 scope/坏 Host/坏 Origin/票据重放拒绝 | http-api.test 鉴权矩阵（401/403 分级）、ws.test 重放与超时用例 |
| 显式退出保存状态、无遗留进程 | 真机：`POST /v1/shutdown`（root 令牌）→ 优雅退出 code=0，tasklist 按 PID 查无遗留 |
| 配对/凭证撤销 | pair→使用→revoke→立即 401（http-api.test） |
| 限额持久化与查询（#43 Runtime 层） | usage record → limits 视图剩余额度；跨重启保留；config Schema 版本拒绝 |
| 勿扰持久化与 MCP 门控（#44 Runtime 层） | DND 跨重启持久化；maneki_notify 在勿扰/通道关/预算超限时按确定性规则拦截，urgency=high 不穿透（mcp-bridge.test） |
| MCP 表达桥协议面 | 官方 SDK（1.32.2）InMemory 契约测试：四工具清单、无执行/审批工具、非法状态拒绝 |

## 未验证 / 剩余 gate（不冒充验收）

- **安装器**：安装包无须用户另装 Node、两个"已安装入口"并发启动——当前以同一 CLI 进程模拟双入口，Tauri 打包与安装器流程未做。
- **性能**：空闲总内存 < 150MB、事件→动画 p95——需要完整 Shell + Runtime 进程树测量，未测。
- **dsh spike（M2 核心 gate）**：本机未检出 dsh（`command -v dsh` 无结果），版本、事件、新建受控会话、原生审批可达性、完整 TaskSnapshot、输入/取消均未验证。**dsh 安装后补做；在此之前 M2b 不开工。**
- **外部记忆协议 spike（#46）**：用户自建 MCP 记忆服务未提供端点，客户端实现仅有替身契约测试，真实服务对接待服务可用。
- **macOS/Linux**：未验证，平台矩阵另验。
- **受控 IPC/启动器管理入口 UI**：当前以 HTTP + root 令牌文件代行；正式管理入口与凭证迁移到 OS 凭证存储为后续项。

## 安装器打包与内存测量（2026-10-31 续）

**打包管线**：`packages/runtime/scripts/build-runtime-bundle.mjs` —— esbuild 把 CLI（含 @maneki-pet/core）打包成 639.7KB 单文件 JS + 复制 Node v24.12.0 为带 target triple 的 sidecar（89MB）；`tauri.conf.json` 声明 `externalBin: [binaries/maneki-runtime]` + `resources`，beforeBuildCommand 串联构建。产物已 gitignore（可重建）。

**安装器**：NSIS `Maneki_0.1.0_x64-setup.exe` 24.7MB / MSI 36.7MB（构建 EXIT=0）。静默安装（/S）后布局含 `maneki-desktop.exe`、`maneki-runtime.exe`（sidecar）、`resources/maneki-runtime-bundle.js`。**从安装目录直接运行 sidecar+bundle：ready + health OK**——运行时即安装器自带的 node.exe，无须用户另装 Node（M2 出口项前半，真机证据 2026-10-31）。双入口锁拒绝此前已真机验证；"桌面+插件两种 Shell 入口"接线未做，该项整体不勾选。

**内存测量（预算 <150MB，§8；按进程树原始统计，不缩减范围）**：

| 进程 | 工作集(WS) | 私有内存(Private) |
|---|---|---|
| Runtime（空闲 10 采样稳定） | 51.3MB | 61.6MB |
| Shell 树（maneki-desktop + 6×msedgewebview2，含空闲动画） | 393–402MB | 182.2MB |
| **合计** | **402.6MB** | **243.7MB** |

**两种口径均超 150MB 预算**。与 M1 记录的"约 29MB（CDP 口径）"是不同统计口径——CDP 侧数字不覆盖 WebView2 多进程基线与 GPU/网络辅助进程。按 §8"记录原因与后续决策，不缩减统计范围"：这是**架构级决策点**而非测量遗漏——(a) 预算统计口径需明确（进程树 WS / Private / CDP JS 堆之一）；(b) WebView2 的多进程基线（本机实测 Private ~182MB）使 150MB 目标在 Tauri+WebView2 技术栈下按全树口径不可达，需要在"重定义预算口径"与"§3.3 的 WebView 选型复核"之间决策。决策前不勾选内存出口项。

**决策记录（2026-10-31，用户三选一拍板）**：采用"修订预算 + 钉死口径"——预算改为**全相关进程树私有内存（Private Bytes）≤ 250MB，其中 Runtime ≤ 75MB**，口径写入 architecture §8 并同步 AGENTS.md/roadmap；§3.3 选型复核不再单独进行（Electron 更重，WebView2 已是 Tauri v2 在 Windows 的现实下限，182MB 即技术栈基线）。按新口径实测 243.7MB（Runtime 61.5 + Shell 树 182.2）**达标**，内存出口项已勾选。

## Shell ↔ Runtime 接线（2026-10-31 续2）

**实现**：Rust setup 自动拉起 runtime sidecar（CREATE_NO_WINDOW、stdin 管道保持 MCP 桥待客户端、**Shell 退出不杀 Runtime**）；Tauri 命令 `runtime_info / read_root_token / spawn_runtime / sync_tray_dnd`；托盘勿扰开关发出 `maneki://dnd-changed` 事件由 Shell 转写为 `POST /v1/dnd`（双向：连接时反向对齐托盘勾选）；TS `runtime-client.ts`（健康发现→必要时拉起→root 配对+令牌缓存→WS 一次性票据订阅，断线 3s 自动重连）；设置面板呈现连接状态、今日限额剩余、通知预算、勿扰状态；`notification.sent` 事件进状态气泡。CSP connect-src 放行 127.0.0.1:18100；Runtime 增加白名单 Origin 的 CORS 回显与 OPTIONS 预检（CORS 非鉴权替代，鉴权仍逐请求）。

**真机证据（NSIS 静默安装后，2026-10-31）**：
1. Shell 启动自动拉起 Runtime：`maneki-desktop.exe` 与 `maneki-runtime.exe` 同时在跑，`GET /v1/health` 18100 OK
2. Shell 自动配对：`/v1/clients` 出现 `desktop-shell`（express+notify），创建时间在 root 之后 0.5s
3. **强杀 Shell → Runtime 存活并继续服务**（health 仍 OK）——红线"关闭窗口只断开客户端，后台继续跟踪"真机证据
4. 显式退出（root `POST /v1/shutdown`）→ Runtime 干净退出

**测试**：runtime 50 条（新增白名单 Origin 的 CORS 预检/回显用例）；全仓 build/test 绿。

**待人工验收**：托盘点击→勿扰联动与事件气泡的视觉确认（托盘菜单人工验收为 M1 遗留项）；WS 事件气泡的实际显示效果。

**结论（更新）**：#43/#44 的 Shell 呈现与接线层完成并有真机证据；两票保持 open 的剩余项为人工视觉确认与 M4 主动内容本体（碎碎念/简报）。dsh spike 与外部记忆对接仍等用户。

**卸载**：/S 卸载正常；运行中的 runtime 文件被锁残留，停止后可清除——正式验收需先提示退出再卸载。

## dsh 接入 spike 首轮（2026-10-31，dsh 0.2.1-rc.5）

用户已安装 dsh（npm 全局 `@deepseek-ai/dsh`，`dsh --version` = **0.2.1-rc.5**）。CLI 面：profiles（web/tui/headless；本机 tui 未装需 plugin add）、`dsh headless "<task>"` 一次性任务、`--json` ndjson 事件、`--session-id` 会话恢复、`--dump-config-schema` Cordis 配置面。

**headless `--json` 事件流实测**（MISSING_CREDENTIAL 场景下结构已完整）：

```ndjson
{"type":"session","sessionId":"session-07f0f8f7-…","cwd":"C:\\…\\dsh-spike"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"status","phase":"step_end","turn":1,"step":1}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"llm-deepseek: no API key …","code":"MISSING_CREDENTIAL"}}}
{"type":"final","text":""}
```

与 HarnessEvent 映射评估：`turn_start → task.started`；`turn_end(error) → task.error`；`final → task.completed`；`needs_input / cancel` 待活体验证。

**能力面发现**：web profile 为 **token 门禁 HTTP**（`?token=` → 303 → Set-Cookie 签名围栏，HttpOnly + SameSite=Strict + 30 天）——不是 dsh-pet 早期调研所称"无鉴权本机 HTTP"，与本仓库 §7.1 取向一致，可借鉴。插件体系含 `dsh-api-gateway / api-session-controller / api-job-controller / client-ui-approval / client-ui-permission-presets / client-ui-user-questions（等待输入）/ api-remotes`——**原生审批 UI 在 harness 内**（client-ui-approval），正向满足 §5.1 native 要求的方向。配置 schema 关键词计数：approval×16、permission×10、session×88、credential×10、sandbox×29、cancel×0（配置层无 cancel 条目，运行时取消待活体验证）。

**Adapter 能力分级预评（依据 spike，✱ 待活体确认）**：`events: ✓`（headless ndjson）；`newTask: ✓`（headless 一次性=受控新会话）；`continueSession: ✓✱`（--session-id 官方支持）；`query: 部分✱`（会话恢复存在，TaskSnapshot 完整性待验）；`approval: native ✓✱`（harness 内审批 UI 插件）；`reply/补充输入: ✓✱`（user-questions 插件指示，API 形态待探）；`cancel: ✗ 未发现`。

**gate**：`DEEPSEEK_API_KEY` 未配置 → 活体任务 spike（完整事件流、final 文本、`--session-id` 恢复快照、审批触发、输入/取消探测）待用户在**自己的环境**设置凭证后补测（web Models 页 credentials 服务或环境变量；凭证不经 Maneki 代码与本仓库）。


## dsh 活体任务 spike（2026-10-31 续3，凭证就绪后）

凭证（用户在自己环境设置 DEEPSEEK_API_KEY，经 PowerShell 用户级环境中继给 dsh 子进程，值不经本仓库与日志）就绪后，四项活体验证全部完成：

1. **完整事件流 + final**：session → turn_start → step_start → **thinking** → **text（流式）** → step_end（**含 usage：inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens**） → turn_end(reason.kind=completed) → final(text)。新增事件类型 thinking/text/tool_call/tool_result 补齐首轮；usage 计量可直接喂限额记账（注：一次极小任务 inputTokens≈7000——harness 系统提示很大，限额口径要按 dsh 实际计费算）。
2. **会话恢复（continueSession ✓ 转正）**：--session-id 接续同一 session，turn 编号延续（turn:2），上下文完整（准确复述上轮指令），增量计量可见（input 248 + cacheRead 6784，DeepSeek prompt 缓存生效）。
3. **工具流与审批（关键安全发现）**：tool_call 携带完整 tool 名与 input（含命令原文）；**workspace 内读写/删除自动执行**；**workspace 外写 → 两层防御**：先 sandbox 拒绝（file access denied under workspace-write mode），agent 再以 sandbox_permissions:danger-full-access + justification 请求升级 → **requires approval, but no approval channel is available → fail-closed 拒绝**（非挂起、非静默放行，与 Maneki 审批红线同向）。tool_call 的 input + justification + sandbox_permissions 即 §5.4 PermissionRequest 的现成素材；dsh 自述审批通道可插（permission hook）——**宠物审批桥的挂点就在这里**。
4. **取消（cancel ✗ 定案）**：headless 无取消 API/事件——中途终止进程后事件流止于最后的 tool_call，无 cancelled/final 事件。Adapter 的取消 = 进程终止 + 会话恢复对账（--session-id 恢复仍可用）。

**Adapter 能力分级终评（dsh 0.2.1-rc.5，活体验证）**：events ✓（ndjson 全流）；newTask ✓；continueSession ✓（活体验证）；query 部分（恢复可用，快照完整性=历史重放）；approval **fail-closed ask**（workspace 内自动、越界需审批通道、无通道即拒——可接 Maneki 审批桥，native 跳转目标为 dsh web/tui UI）；reply ✓（会话恢复+继续）；cancel ✗（进程终止语义）。

**M2b 设计含义**：① DSH_PERMISSION_MODE 必须显式设为 workspace-write（默认即如此），不得用 danger-full-access；② dsh 派发的危险操作天然 fail-closed，Maneki 审批桥可通过 permission hook 挂入（M5+）；③ 限额记账可用 step_end.usage 的真实 token 数。

## M2b 前置：HarnessAdapter 契约与 dsh 观察适配器（2026-10-31 续4）

- Core 契约代码化：§5.1/§5.2 v1 类型（TaskRequest/Snapshot、PermissionRequest、HarnessEvent 载荷联合、AdapterCapabilities）+ checkCapabilityConsistency 注册时校验（approval none 限制派发；bridge 需 decidePermission+queryOperation）。
- 新包 @maneki-pet/adapter-dsh：观察 v0，能力声明忠实活体 spike（events-only；approval none——headless 危险操作 fail-closed 无审批通道；数据边界 cloud: api.deepseek.com）。DshEventMapper 以活体转录为契约测试（session/status/thinking/text/tool_call/tool_result/final → HarnessEvent；usage 与 completed tool_result 不进事件流防洪泛）。
- 全仓 161 条测试绿（core 72 + adapter-dsh 13 + desktop 24 + runtime 52）。
- **派发 gate（M2b 决策点）**：dsh headless 无用户可达审批 UI（fail-closed 已验证），按 §5.1 不得启用派发。三条路：(a) 探索 web profile /api 网关作为派发+审批通道；(b) permission hook 审批桥（M5+ 方向）；(c) 修订 §5.1 接受"沙箱内自动 + 越界 fail-closed"为 native 变体（架构变更需决策）。


## web /api 网关探索（2026-10-31 续5，派发路线 (a) 可行性定案）

对 web profile 前端 bundle 与 npm 安装内插件包的静态分析 + cookie 围栏活体验证：

- **传输**：/api/remote.mux 单 WebSocket 复用全部 Typert 远程流（帧形 {type:"item", streamId, …}）；unary RPC 与 $events 应用事件流并存；鉴权 = token 门禁换签名 Cookie（HttpOnly + SameSite=Strict）。
- **官方客户端就在用户安装内**：@deepseek-ai/dsh-api-gateway/lib/client.node.js（RemoteStreamMuxClient + ClientRemoteService）与各控制器的生成式 typert.remote-client.js（zod schema 全量类型化，Generator 生成、禁止手改）。
- **方法面（生成绑定实测）**：session.cancel → {accepted:true}（**取消能力存在，修正此前配置层的 ✗**）；session.control → projections{asOfSeq, inbox, workingDirectory, title, todos,…}（**TaskSnapshot 等价物，asOfSeq 与 §5.1 sourcePosition 语义对齐**）；approval.allow / approval.reject / permission.access（审批可经网关应答）；session.new / fork / archive / search / hierarchy。
- **派发路线 (a) 定案：可行**。M2b dsh 适配器的正确形态 = 连接（或受控启动）web profile，经官方生成客户端走网关完成派发/快照/取消，审批 native routeId 指向 dsh web UI 的审批页。实现量 = M2b 里程碑本体（网关客户端接线 + Task Broker + 运行器），实现方式二选一：运行时动态 import 用户安装内的官方生成客户端（版本绑定已装 dsh），或按 zod schema 自实现最小客户端（协议自担）。


## 网关活体派发链路探针（2026-10-31 续6，M2b 前置探针完成）

纯 HTTP unary（无需 WS）即可驱动完整派发链：`POST /api/<endpoint>`，body 为 `{type:"client-request", rpcId, method, payload:{args:{<参数名>: request}}}`（参数名因方法而异：list=`_request`、create/prompt/page/projections=`request`、control 为 stream 方法不可 unary），鉴权 = Cookie 围栏。实测链路：

1. `session/create {cwd}` → sessionId
2. `session/prompt {sessionId, requestId(客户端幂等键), mode:"queue", content:[{type:"text",text}], clientTimeZone}` → `{accepted:true}`
3. 轮询 `session/list`（running/asOfSeq/tokenUsage）+ `session/projections` → turnOutline 实录 **{turn:1, seq:4, prompt:"Reply with exactly: M2B-OK", response:"M2B-OK"}**，tokenUsage {uncachedInput:9375, output:6}，sessionStats {llmMs:1153, ttftMs:1139}
4. modelSelection 投影含 provider/model/reasoningEffort（deepseek-flash/high）

**注意点**：① 网关 unary 的 envelope 校验严格（payload 形状/参数名逐方法不同——权威来源是生成描述符的 `parameters[].name`）；② `session/control` 是 stream 方法（mux WS 专用），unary 取快照用 `session/projections`；③ 新会话即用默认模型（deepseek-flash），无需显式 initializeDefaultModel；④ prompt 的 requestId 即 dsh 原生幂等键——与 Maneki clientRequestId 哲学对齐。

**M2b 实现路径定稿**：DshAdapter 派发层 = HTTP unary 网关客户端（本探针协议）+ headless `--json` 事件流（异步任务）双通道；approval: native（routeId 指向 dsh web UI）；asOfSeq 快照对账用 session/projections。剩余实现 = Core Task Broker + 适配器派发层 + 运行器，全部无需再探协议。


## DshAdapter 派发层实现（2026-10-31 续7，路线 (a) 实现完成）

- 新增 DshGatewayClient：活体验证的 unary 线协议客户端（envelope、token 门禁换 Cookie、逐方法参数名映射 list=_request/其余=request）。
- DshAdapter 双模：无 gateway 配置保持观察 v0；配置后能力升级 newTask/continueSession/reply/cancel + query=status_only + **approval:native**（dsh 沙箱 workspace-write 内自动、越界 fail-closed 需在其 web UI 审批——活体验证的 native 机制）。submit 的 prompt.requestId = Maneki brokerRequestId（dsh 原生幂等键与 Broker 对齐）；reply 走 steer 模式（requestId=inputId）；query 经 session/projections 的 asOfSeq+turnOutline 出 status_only 快照（产物引用未验证不虚报 full）；cancel 经 session/cancel 并在登记表标记 cancelled。
- 契约测试：stub 网关（严格按活体线协议）覆盖 登录失败/submit 幂等键透传/status_only 快照/not_found/steer reply/cancel 标记/观察模式派发拒绝，共 21 条。全仓 169 条测试绿（core 72 + adapter-dsh 21 + desktop 24 + runtime 52）。
- **未做（下一步）**：Core Task Broker（§5.3 状态机+持久化+串行/有界并发）与 Runtime 装配（dsh web profile 的受控启动/发现）——M2b 剩余主体。

## 结论（更新）

M2 出口项"安装包无须用户另装 Node"已有真机证据；内存预算决策落地达标；Shell↔Runtime 接线真机验收通过；dsh spike 三轮完成（结构化事件流、会话恢复、审批 fail-closed、取消语义）且 HarnessAdapter 契约 + dsh 观察适配器落地（161 条测试绿）；网关派发路线定案可行。剩余：M2b 派发审批故事决策、外部记忆对接（待服务端点）、#43/#44 人工视觉确认。

## 扩展功能域：技能包与平台运营（2026-10-31 续8，与 EverNook 共建）

依据 EverNook 契约（adapter-conformance-v1 / capture-v1 / experience-v1、ADR-0006、spec 技能增量节）实施，EverNook 仓库零改动：

- 文档定稿：architecture §10（技能包/平台对接器/EverNook 集成形态）、ADR-0002、GLOSSARY 七词条、roadmap 扩展功能域批次（7b468f0）。
- 票 #49 EverNook shim：packages/adapters/evernook 实现 AdapterSurface，ConformanceSuite 七项全过（py3.14 venv 实跑，251ee26）——竖切①。
- 票 #47 Core skill-pack v1：清单校验（kebab id / semver / 脚本路径穿越拒绝 / SHA-256）+ 哈希核对，9 条测试。
- 票 #48 平台对接器：platform-core（DraftFlow 六步逐次确认门控、元数据/运营数据契约校验）+ platform-bilibili（exportPackage 四件套导出+双重校验、manual-export 运营数据解析、JSON Schema 两份），d40d93f / 404a74b——竖切②③。
- CLI @maneki-pet/cli：platform draft（交互+文件双模）/ package / receipt / ops-import / experience-span。调试后修复：stdout 污染（提示移 stderr）、shim stdin 事件结构（source 嵌套）、附件分块元组、experience-span 取值。竖切④⑤⑥真机全过：输入→tool_call→tool_result+元数据附件（gaps=0）→EvidenceSpan（BVID 精确坐标）→读回一致；证据摘要 C:\maneki-lab\evernook-vertical-evidence.json。
- 全仓测试 190 条绿（core 81 + adapter-dsh 21 + platform-core 8 + platform-bilibili 5 + cli 2 + runtime 52 + desktop 24）。
- 全仓测试 193 条绿（core 81 + adapter-dsh 21 + platform-core 8 + platform-bilibili 5 + cli 2 + runtime 52 + desktop 24）。
- 红线核验：无 biliup / 协议模拟 / UI 自动化；写操作逐次确认；无全自动档；EverNook 零改动。
