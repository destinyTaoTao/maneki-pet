# 模板碎碎念第一批 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付无模型、无声音的模板轻陪伴：低频自动碎碎念、来一句、暂停/关闭、单端气泡与动作，以及用户主动回应后的主会话引用。

**Architecture:** Core 保存协议数据类型、模板和纯规则；Runtime 在现有 SQLite v6 上保存偏好/预算/已提交引用，拥有租约、调度和权限。Desktop 复用独立助手凭证与一个 assistant 事件连接，负责交互门禁、气泡和动作；可靠提醒继续由原 ReminderScheduler 独立调度。

**Tech Stack:** TypeScript strict、pnpm workspace、Node ≥22、node:sqlite、Vitest、Tauri v2；不新增生产依赖。Windows 为本轮验收平台。

**Spec:** [architecture §4.3.1](../../architecture.md#light-companionship)、[协议 v1 / §4.3.2](../../architecture.md#companion-protocol-v1)、[验收清单](../../roadmap.md#light-companionship)、[ADR-0006](../../adr/0006-template-first-companionship.md)。架构是规范来源，计划不另改契约。

**Baseline:** `e6de3866a35df6fb47344fef6f80d3eac95d2e98`，设计文档已单独提交并推送 origin/main。下列文件路径均相对仓库根目录；现有 `ASSET-LICENSE.txt` 和 `.playwright-cli/` 改动不属于本任务。

**Execution status:** 用户于2026-11-14授权先单独提交并推送本计划，再开始实施及相关测试验证。实施开始时各任务尚未执行；产品代码按任务推进，安装替换及发布不在本轮范围。后续代码提交另行授权。

## Global Constraints

- 自动两次至少间隔 **7200000 ms**；助手时区自然日 **4 次**，滚动 24 小时 **4 次**；首次合格展示登记后暖机 **7200000 ms**，重启不重置。
- 租约 **15000 ms**，每 **5000 ms** 续租；候选最多 **15000 ms** 且不跨本地当日；引用 **600000 ms**；气泡显示 **6000 ms**。
- 一个 socket 一个展示实例，每客户端最多 **4**、Runtime 最多 **32**；引用 **32/实例、64/客户端、256/Runtime**；手动缓存 **16 条/lease、最多10分钟**，同客户端新点播至少 **3000 ms**。
- 新 companion 请求 **8 KiB**，响应/单条事件 **16 KiB**；模板最多 **128**，正文最多 **80 UTF-16 code units**；Attempt 最多 **16 条/72小时**，Used 最多 **256 条**。
- 固定协议版本 **1**、设置 schemaVersion **1**、数据库 **v6**；沿用 §4.3.2 的字段、错误码与状态校验顺序，不增加通用消息系统、新 scope、Provider 或包格式。
- Core 不依赖具体 IO；Runtime 不放宽 127.0.0.1、token、Host/Origin 和 scope；表达内容以 textContent 渲染，引用是数据，不作为命令。
- 自动模板不读个人摘要、不调用 LLM/ASR/TTS、不发系统通知；来一句不受自动预算/勿扰拒绝分支限制，仍不播音、不抢麦。
- 不改个人提醒业务/投递语义，不把 completed 快照接成会话动态通知；不实现每日简报、长期记忆、天气、截图、多宠或原生会话跳转。
- 只读现有授权数据；测试使用临时配置目录/临时数据库/本机替身，不使用用户运行中的 Runtime、凭证或真实提醒，不发生计费调用。
- 标识符英文，UI 文案集中中文；不全仓重排或重构大文件。全进程树 ≤300 MiB、Runtime ≤75 MiB、正常提醒调用 p95<1s；macOS/Linux 未在本机验证。

## Review Focus

1. **同凭证两个 socket**：仅目标连接收到表达，其他 assistant 连接也不能旁收。由 Task 3 的目标路由测试覆盖。
2. **HTTP 成功响应丢失后重启/过期**：手动点播不能生成第二句；已提交引用聊天应返回原持久结果。由 Task 4、5 覆盖。
3. **窗口隐藏后休眠，单调时钟行为不同**：恢复先失效旧租约，过期气泡不补显。由 Task 6 的双时钟测试和 Task 8 的原生场景覆盖。
4. **旧 Runtime 保存设置或清历史后再次升级**：偏好保留、孤儿引用消失、已投递提醒不回到 pending。由 Task 2、5、8 覆盖。
5. **开始说话或重要提醒到达时，旧气泡定时器仍在运行**：闲聊让位，旧回调不能关掉新内容，最新等待状态保留。由 Task 7 覆盖。

## 文件与依赖边界

新增文件均在实现相应任务时才创建；本计划没有创建这些源码或测试。

| 任务 | 新文件 | 现有文件的必要修改 |
|---|---|---|
| 1 | core/src/companion-types.ts、companion-policy.ts、companion-templates.ts；core/tests/companion-policy.test.ts | core/src/index.ts；保留 proactive.ts/briefing 既有导出和测试 |
| 2 | runtime/src/companion-store.ts、companion-clock.ts；runtime/tests/companion-store.test.ts、companion-settings.test.ts | assistant-store.ts、assistant-settings.ts、assistant-service.ts |
| 3 | runtime/src/companion-leases.ts；runtime/tests/companion-leases.test.ts | events.ts、ws.ts、tests/ws.test.ts；runtime.ts 的 WS 依赖接线 |
| 4 | runtime/src/companion-service.ts、companion-http.ts；runtime/tests/companion-http.test.ts、companion-scheduler.test.ts | http-api.ts、assistant-http.ts、assistant-service.ts、runtime.ts |
| 5 | runtime/src/companion-references.ts；runtime/tests/companion-references.test.ts | assistant-store.ts、assistant-service.ts、tests/assistant.test.ts |
| 6 | desktop/src/companion-client.ts、companion-client.test.ts | runtime-client.ts/.test.ts、assistant-panel.ts、assistant-client.ts |
| 7 | desktop/src/companion-bubble.ts/.test.ts、companion-presence.ts/.test.ts | main.ts、assistant-panel.ts/.test.ts、assistant-text.ts、assistant.css、voice-pet.ts/.test.ts、src-tauri/src/lib.rs |
| 8 | runtime/tests/companion-integration.test.ts；实际验收时创建对应 docs/audits 证据 | roadmap.md、README.md；不重打或覆盖封存 alpha.2 |

表中 core/runtime 前缀分别为 `packages/core`、`packages/runtime`；desktop 为 `apps/desktop`。测试复用 `packages/runtime/tests/fetch-compatible-runtime.ts` 的可 fetch 端口分配，不另造随机端口重试掩盖启动失败。

执行依赖：`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8`。Task 3 的 lease/WS 不依赖 quote；Task 5 必须在提交主会话前完成引用的独立检查。逐任务先定向回归，所有接口一致后再执行全仓门禁和原生验收。

## Task 1: 协议数据类型、原创模板与纯准入规则

**Files:** 创建 `packages/core/src/companion-types.ts`、`companion-policy.ts`、`companion-templates.ts`、`packages/core/tests/companion-policy.test.ts`；修改 `packages/core/src/index.ts`。

**Interfaces:**
- 类型文件将规范的 preferences/budget/Attempt/Used/S/L/E/引用分别命名为 `CompanionPreferences`、`CompanionBudget`、`CompanionAttempt`、`CompanionUsedTemplate`、`CompanionDisplayState`、`CompanionLease`、`CompanionUtterance`、`CompanionReplyTo`、`CompanionReference`。同文件导出 `CompanionStatus`、`CompanionPolicyEvent` 及 acquire/renew/release/say/ack 的 Request/Response 类型，字段逐项照 §4.3.2，不增添客户端信任字段。
- `CompanionPolicyInput`：`nowMs:number,timeZone:string,preferences:CompanionPreferences,budget:CompanionBudget|null,dnd:boolean,storageHealthy:boolean,clockTrusted:boolean,displayAvailable:boolean,contentAvailable:boolean`。
- `evaluateCompanion(input:CompanionPolicyInput):{allowed:boolean,reason:CompanionStatus['automaticBlock'],nextEligibleAt:number|null}`；纯函数，按规范优先级拒绝。
- `CompanionTemplate`：`id:string,theme:string,text:string,actionId:string|null,hours:readonly number[]`（空 hours 表示不限时段）；导出 `companionTemplates:readonly CompanionTemplate[]`。
- `selectCompanionTemplate(input:{mode:'automatic'|'manual',hour:number,excludedIds:ReadonlySet<string>,lastTheme:string|null,lastTemplateId:string|null},templates:readonly CompanionTemplate[]):CompanionTemplate|null`。稳定顺序选择下一合适候选，不用模型；manual 池耗尽可复用但避免紧邻重复。Runtime 将已用内容哈希映射为目录内所有同正文模板ID并加入 excludedIds，Core 不自行计算哈希。

- [ ] **写失败测试**：测试 fixture `eligibleInput()` 返回暖机已过、无勿扰、有展示/内容、预算为空、可信时钟的输入；断言 `evaluateCompanion({...eligibleInput(),dnd:true}).reason === 'dnd'`。继续覆盖 `7199999/7200000` 边界、同日第5次、跨午夜仍受滚动24h限制、时区切换、候选为空及损坏优先级。
- [ ] **运行红灯**：`pnpm --filter @maneki-pet/core exec vitest run tests/companion-policy.test.ts`；预期因新导出/行为尚不存在失败，而非安装或环境错误。
- [ ] **实现上述纯函数与类型**：首批编写24条原创短句、至少6个主题，包含通用和时段问候；模板不暗示已观察用户行为。SHA-256 由 Runtime 标准库计算并转换为模板ID排除集，Core 不导入 crypto。现有 ProactiveEngine 的45分钟触发不接入新服务，也不删除每日简报逻辑。
- [ ] **运行绿灯与旧规则回归**：`pnpm --filter @maneki-pet/core exec vitest run tests/companion-policy.test.ts tests/proactive.test.ts tests/briefing.test.ts`；全部通过，数值与模板上限断言真实执行。人工读24条台词，排除语义重复和虚假事实。
- [ ] **检查 diff，形成独立交付**：候选提交 `feat: add deterministic companion policy and templates`；只有未来明确授权提交时才执行。

## Task 2: 独立偏好、持久预算与设置兼容

**Files:** 创建 `packages/runtime/src/companion-store.ts`、`companion-clock.ts`、`packages/runtime/tests/companion-store.test.ts`、`companion-settings.test.ts`；修改 `assistant-store.ts`、`assistant-settings.ts`、`assistant-service.ts`。

**Interfaces:**
- `CompanionStore` 构造依赖现有 `AssistantStore`，提供 `initialize(nowMs:number):void`、`readState():{preferences:CompanionPreferences,budget:CompanionBudget}`、`transaction<T>(run:()=>T):T`、`writePreferences(value:CompanionPreferences):void`、`writeBudget(value:CompanionBudget):void`。write 方法仅供已开启事务调用，不再嵌套 BEGIN；初始化/读取校验遵守两键同时缺失才可新建的规则。
- `CompanionClock` 构造注入 `wallNow:()=>number,monoNow:()=>number`；`sample(lastTrustedWallAt:number):{nowMs:number,monoMs:number,trusted:boolean}`。保存进程内采样基线，回退/跳变按规范保守处理，预算不清零。
- 保留 `readAssistantSettings`/`saveAssistantSettings`/`settingsView` 的现有公开用途。GET view 合并 CompanionStore 偏好，PUT 先拆出 companion，再在原保存事务中写独立键；version 只推进一次，普通 voice/apiKey 的省略保留逻辑不变。

- [ ] **写失败测试**：临时 v6 库初始化后，关闭自动、普通旧形状 PUT 再读取，断言 `view.companion.murmurEnabled === false`；`PRAGMA user_version` 保持6。覆盖 companion null/空对象/只读时间字段拒绝、旧客户端省略保留、事务写失败整体回滚、preferences存在budget缺失时503且不初始化。
- [ ] **运行红灯**：`pnpm --filter @maneki-pet/core build` 后执行 `pnpm --filter @maneki-pet/runtime exec vitest run tests/companion-store.test.ts tests/companion-settings.test.ts`，确认因新功能缺失失败。
- [ ] **实现存储与设置投影**：精确采用三个 KV 前缀与 formatVersion=1，记录有界；预算异常不让普通 settings/chat 读取失败。暂停命令此时只准备事务写入口，HTTP 权限/幂等由 Task 4 接入。持久预算在一次认领事务内读、判定、写，不能先写配置再异步补预算。
- [ ] **补时间与降级回归**：两小时重启边界、自然日/滚动计数、暖机firstEligibleAt不重置；利用旧版保存形状重建 assistant.settings 后独立偏好仍在，未知formatVersion不重置。模拟时钟后退，断言自动决策 clock_untrusted，原提醒行逐字段未变。
- [ ] **绿灯及 diff**：复跑两项新测试和 `tests/assistant.test.ts tests/reminder-management.test.ts`；候选提交 `feat: persist companion preferences and budgets`。

## Task 3: 单连接租约与服务端目标路由

**Files:** 创建 `packages/runtime/src/companion-leases.ts`、`packages/runtime/tests/companion-leases.test.ts`；修改 `events.ts`、`ws.ts`、`runtime.ts` 和 `tests/ws.test.ts`。

**Interfaces:**
- `EventAudience={clientId:string,connectionId:string}`；`EventFeed.publish(kind:string,payload?:Record<string,unknown>,audience?:EventAudience):RuntimeEvent`。内部 listener 增加可选 audience 参数，旧单参订阅者兼容；audience 不放进 RuntimeEvent，也不序列化到网络。
- `WsHub.ownsConnection(clientId:string,connectionId:string):boolean`；ready 添加 connectionId/runtimeEpoch。构造注入 `runtimeEpoch:string` 与 `onConnectionClosed:(connectionId:string)=>void`，关闭/撤销通知 lease 模块，默认旧事件不受目标路由影响。
- `CompanionLeases.acquire(clientId:string,request:CompanionAcquireRequest):CompanionLease`、`renew(clientId:string,request:CompanionRenewRequest):CompanionLease`、`release(clientId:string,request:CompanionReleaseRequest):{released:true}`；构造注入 scopes、ownsConnection、wall/mono clock、runtimeEpoch、policyRevision读取。
- `selectEligible():CompanionLease|null`、`invalidateConnection(connectionId:string):void`、`invalidateClient(clientId:string):void`、`close():void`；选择按规范收到activitySeq递增的先后，再按登记顺序。状态/归属存于模块内部，不让调用方改原对象。

- [ ] **写失败测试**：同一 clientId 建立两个真实本地 WS，给连接A定向事件，断言A收到一次且B/express/未登记旧连接零次；普通 assistant.changed 仍按原scope发送。测试服务器不得监听非回环。
- [ ] **运行红灯**：`pnpm --filter @maneki-pet/runtime exec vitest run tests/companion-leases.test.ts tests/ws.test.ts`，预期定向/新ready断言失败。
- [ ] **实现连接与租约行为**：服务端 UUID 连接身份，15000/5000期限，acquire重复不续期、同seq renew重复不延长、换正文/跳号拒绝；过期/释放只能重新建立socket，4/32容量不驱逐活动端。绑定来自HTTP/WS身份，不能相信payload目标。
- [ ] **运行绿灯与泄漏检查**：断线、撤销、Runtime stop后lease失效；旧socket ready兼容、没有audience/clientId意外网络泄漏。测试输入同时覆盖另一客户端未知lease404与自身过期410。
- [ ] **检查 diff**：候选提交 `feat: bind companion delivery to websocket leases`。

## Task 4: Runtime 调度、点播、暂停及 HTTP 闭环

**Files:** 创建 `packages/runtime/src/companion-service.ts`、`companion-http.ts`、`packages/runtime/tests/companion-http.test.ts`、`companion-scheduler.test.ts`；修改 `http-api.ts`、`assistant-http.ts`、`assistant-service.ts`、`runtime.ts`。

**Interfaces:**
- `CompanionService` 依赖 `CompanionStore`、`CompanionLeases`、`CompanionClock`、EventFeed、当前设置/DND/historyEpoch/active读取函数和可注入 timers。提供 `status():CompanionStatus`、`say(clientId:string,request:CompanionSayRequest):CompanionSayResponse`、`ack(clientId:string,request:CompanionAckRequest):{recorded:true}`、`wake():void`、`policyChanged():void`、`stop():void`。
- 同模块提供 `resolveReference(clientId:string,replyTo:CompanionReplyTo):CompanionReference`，只读取本客户端可引用快照，过期/归属/epoch校验在此集中；Task 5 决定何时调用。
- `handleCompanionHttp(req:IncomingMessage,res:ServerResponse,client:{clientId:string,scopes:string[]},service:CompanionService,readBody:(maxBytes?:number)=>Promise<Record<string,unknown>|undefined>):Promise<boolean>`；命中 status/display/say/ack 后返回true，未命中false，不吞已有助手路由。http-api.ts 的读取器接受可选上限，companion 子路由按8KiB在读取时拒绝，既有调用仍用原上限；不能读完整个过大正文后才计算长度。AssistantService持有同一个 companion 实例，关闭时停止其定时器/lease，既有完整停机流程仍负责提醒等其他服务。
- 固定暂停仍走现有 mutation 分支，先验 settings 权限再查既有 mutation 缓存；首次请求与 version/偏好写入在同事务，响应按设计原样缓存。HTTP读取/校验和写入均复查有效凭证。

- [ ] **写失败测试**：使用注入时间在7199999ms不发、7200000ms发一次；占预算成功后模拟发送失败和Runtime重启，断言无第二次发送、attempt仍占一次。来一句在DND/暂停中成功但不调用provider/notifier/voice。
- [ ] **运行红灯**：`pnpm --filter @maneki-pet/runtime exec vitest run tests/companion-http.test.ts tests/companion-scheduler.test.ts`；预期新路由或规则缺失失败。
- [ ] **实现校验与调度**：按§4.3.2显式校验各Schema/8KiB边界/错误码，runtimeEpoch每进程生成；有限单次唤醒＋状态变动重算，不每个tick访问模型或无界重试。对模板trim+NFC后用node:crypto SHA-256建立ID排除集，覆盖同正文换ID仍排除的测试。先存Attempt和模板排除，再定向发送；健康变化、DND、设置、清历史发policy事件，scope不扩大。
- [ ] **补协议边界测试**：手动1在途/3000ms限流、16条缓存淘汰后旧seq410、同seq不同内容409、supersedes丢弃旧候选、ACK重复和冲突、60秒ACK边界、引用32/64/256容量；暂停同ID响应丢失后不再延长，原id不同参数冲突，admin单独不能领取展示。
- [ ] **绿灯与现有服务回归**：新两项和 `tests/assistant.test.ts tests/runtime-integration.test.ts tests/reminder-recovery.test.ts` 通过；模型、语音和通知spy计数保持0（原提醒自身调用除外）。候选提交 `feat: wire template companionship runtime endpoints`。

## Task 5: 用户回应引用与旧历史兼容

**Files:** 创建 `packages/runtime/src/companion-references.ts`、`packages/runtime/tests/companion-references.test.ts`；修改 `assistant-store.ts`、`assistant-service.ts`、`tests/assistant.test.ts`。

**Interfaces:**
- `CompanionReferences` 使用同一 `AssistantStore`：`put(epoch:number,userSeq:number,reference:CompanionReference):void`、`get(epoch:number,userSeq:number):CompanionReference|undefined`、`clear():void`、`pruneOrphans():void`；put/clear由已有主会话事务调用，不独立提交。
- 现有 AssistantMessage 添加可选 companionReference；messages/message/history/snapshot共用同一读取合并路径。引用KV随主会话历史保留，读取只按当前分页seq取，不将全部历史加载内存。
- `AssistantService.submit` 只新增 companionReplyTo 可选字段；无引用沿用原指纹，有引用加入三字段规范化指纹。先查持久request，再首次 `companion.resolveReference`，然后消息/请求/引用同事务写入。

- [ ] **写失败测试**：首次引用成功后推进时间超过600000ms并重启，原 requestId/text/replyTo 重试仍返回同一请求，断言用户消息数只增加1；新 requestId 引用过期则410且消息数不增加。
- [ ] **运行红灯**：`pnpm --filter @maneki-pet/runtime exec vitest run tests/companion-references.test.ts`；预期引用字段不支持或无法读回。
- [ ] **实现引用保存与上下文**：只把 text 传给 PersonalDialogue/进度解析；引用单独作为有来源数据参与模型上下文和摘要预算。点击回应不创建消息；普通聊天不改变指纹，已有引用响应重试不能因旧runtimeEpoch再被拒绝。
- [ ] **补清除与降级测试**：清历史同事务删引用/消息/摘要，保留request墓碑；清待办保留引用；在临时库执行旧版清历史形状再升级，pruneOrphans删遗留键而不恢复消息。用引用台词包含“待办：…”验证引用不创建待办；模板正文客户端伪造/跨客户端引用拒绝。
- [ ] **绿灯与范围检查**：复跑引用测试、`tests/assistant.test.ts tests/personal-dialogue.test.ts`；只用已有模型替身验证context，不发外网。候选提交 `feat: preserve companion replies as quoted context`。

## Task 6: Desktop 协议客户端与同一助手连接

**Files:** 创建 `apps/desktop/src/companion-client.ts`、`companion-client.test.ts`；修改 `runtime-client.ts/.test.ts`、`assistant-client.ts`、`assistant-panel.ts`。

**Interfaces:**
- `WsReady={connectionId?:string,runtimeEpoch?:string}`；给现有 `connectEvents(token,onEvent,onStateChange?,onReady?)` 增加末尾可选回调，旧调用者无需改参数。onReady只来自已鉴权帧，自动重连产生新的连接身份。
- `CompanionClient` 构造注入 authenticated HTTP、wall/mono clocks、`reconnectAssistantEvents:()=>void` 及渲染回调；提供 `connected(ready:WsReady):Promise<void>`、`disconnected():void`、`invalidate():void`、`setDisplayState(state:CompanionDisplayState):void`、`onEvent(event:RuntimeEvent):void`、`say():Promise<CompanionSayResponse>`、`ack(utteranceId:string,result:'displayed'|'discarded'):Promise<void>`、`dispose():void`。invalidate先作本地失效，再请求panel停止原订阅并重新连接；不能在旧socket上复活过期lease。
- assistant-panel现有assistant事件订阅保持唯一，增加 `onCompanionEvent`/`onCompanionReady` 可选回调并在reuse阶段接线；不让main的express连接充当私有陪伴连接。新消息/引用/companion设置类型复用Core导出，不维护另一份不同Schema。

- [ ] **写失败测试**：ready没有新字段或status404→轻陪伴不可用且不登记；403→凭证错误，不能当旧版；status旧policyRevision晚于新事件到达时不覆盖新状态。
- [ ] **运行红灯**：`pnpm --filter @maneki-pet/desktop exec vitest run src/companion-client.test.ts src/runtime-client.test.ts`。
- [ ] **实现连接与续租**：探测后才登记，stateSeq连续、一续租在途，从首次请求发出时间算本地截止，重试不延长；断线和dispose释放所有定时器，重连不保留旧displayInstanceId/lease。busy变化立即本地生效，旧事件直接丢弃，不补拉候选。
- [ ] **补退化/幂等测试**：网络延迟、HTTP丢响应、旧epoch、重放manual结果、未知事件、响应超限、引用TTL与展示TTL区分；对旧Runtime保存设置只发送旧字段，不悄悄剥掉引用并提交。
- [ ] **绿灯与独立交付**：新测试加 `src/assistant-client.test.ts` 通过；候选提交 `feat: connect desktop companion protocol lifecycle`。

## Task 7: 气泡仲裁、控制入口与原生展示条件

**Files:** 创建 `apps/desktop/src/companion-bubble.ts/.test.ts`、`companion-presence.ts/.test.ts`；修改 `main.ts`、`assistant-panel.ts/.test.ts`、`assistant-text.ts`、`assistant.css`、`voice-pet.ts/.test.ts`、`apps/desktop/src-tauri/src/lib.rs`。

**Interfaces:**
- `CompanionBubble`：`show(utterance:CompanionUtterance):boolean`、`showImportant(id:string,text:string):void`、`setUserBusy(value:boolean):void`、`dismiss(id:string):void`、`dispose():void`；注入render/playAction/restoreLatest/clock/timers，旧showBubble调用按来源接入，不能全部标成同一优先级。
- `CompanionPresence`：`setVisible(value:boolean):void`、`setBusy(reason:CompanionDisplayState['busyReasons'][number],value:boolean):void`、`noteInteraction():void`、`resume():void`、`snapshot():CompanionDisplayState`、`dispose():void`。由真实输入/voice phase/drag/panel事件调用；不采集全局键盘。
- 新原生命令 `companion_window_visible(window:tauri::WebviewWindow)->Result<bool,String>` 只读取本窗口可见性；通过既有Tauri调用方式使用，不启动子进程。JS结合document.visibility、原生可见性、pageshow及定时/消息处理前的双时钟间隔检查；恢复/不可信时间先触发client.invalidate再重建连接，读取可见性失败按不可见处理。
- panel增加 `openWithCompanionReply(utterance:CompanionUtterance):Promise<void>`：只准备可移除引用草稿；现有submit附加replyTo，用户text保持独立。失败保留草稿，过期引用提示移除后由用户再发送。

- [ ] **写失败测试**：气泡A后3秒显示B，再过3秒A旧定时器触发时B仍显示；到B自己的6000ms才关闭。新输入/录音/重要提醒进入后自动气泡立即退出，动作恢复最新waiting_input而非旧idle。
- [ ] **运行红灯**：`pnpm --filter @maneki-pet/desktop exec vitest run src/companion-bubble.test.ts src/companion-presence.test.ts src/voice-pet.test.ts`。
- [ ] **实现交互入口**：在已有桌宠菜单加入“来一句”“暂停碎碎念两小时”“关闭碎碎念”，设置页显示开关/暂停剩余/不可用原因。后台复用现有assistant凭证；缺凭证的用户显式点播引导现有打开助手流程，启动不默默授权。气泡正文只用textContent，回应/关闭控件可键盘操作，仍遵守人物命中区与穿透规则。
- [ ] **补完整UI测试**：点回应只开草稿，取消不写历史；保存设置不携只读字段；引用显示但正文解析不混入；面板/录音/拖动busy、原生隐藏、恢复时间跳变均不补显旧候选。验证模板action缺失纯文字回退，自动关闭不影响用户主动入口和已有Reminder列表。
- [ ] **绿灯、类型与原生检查**：定向新增测试及 `src/assistant-panel.test.ts` 通过；`pnpm --filter @maneki-pet/desktop typecheck`；因有Rust修改执行 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`，原生构建在Task8统一执行。候选提交 `feat: add quiet companion bubbles and controls`。

## Task 8: 跨包兼容、Windows 体验与交付证据

**Files:** 创建 `packages/runtime/tests/companion-integration.test.ts`；按实际日期创建 `docs/audits/YYYY-MM-DD-template-companionship.md`；更新 `docs/roadmap.md`、`README.md` 的真实状态。

**Interfaces:** 只消费前七项公开行为和正式HTTP/WS入口，不加生产调试端口，不以修改默认频率代替真实体验验收。

- [ ] **写跨包测试并确认故障可见**：同凭证双WS、一个显示一个隐藏；真实临时SQLite在认领后发送前模拟中止，重启不补发；chat引用重试与epoch清除；旧PUT/旧v6保存与清历史的兼容矩阵。每个场景断言具体HTTP状态、消息次数、数据库业务行未变；发现接线缺口先确认失败再修复，若已有实现通过则记录通过，不人为破坏代码制造红灯。
- [ ] **受影响回归**：`pnpm --filter @maneki-pet/runtime exec vitest run tests/companion-integration.test.ts tests/reminder-management.test.ts tests/reminder-recovery.test.ts tests/ws.test.ts`；全部通过再执行全仓门禁。测试只用隔离目录和替身通知。
- [ ] **全仓门禁（按顺序）**：`pnpm -r build`、`pnpm -r test`、`pnpm -r typecheck`。desktop build/test会运行素材生成/验证脚本，执行前核对已有素材改动，不暂存或覆盖用户文件。失败先区分本次与环境，不削弱断言或盲目重跑。
- [ ] **Windows 原生构建**：`pnpm --filter @maneki-pet/desktop tauri build --no-bundle`；不安装替换用户程序、不上传Release。用独立Runtime身份和已有素材启动候选版本，记录构建提交与平台。
- [ ] **实机验收**：无模型、无声音、dsh关闭时“来一句”/设置可用；勿扰无主动气泡；原生隐藏、托盘恢复、真实休眠后不重播；录音/拖动期间让位；用户回应引用与清历史正确。自动频率用虚拟时钟测试证明边界，同时保留至少一轮真实2小时暖机/间隔的试用证据；长时试用是待执行验收，不以调小生产阈值冒充通过。
- [ ] **性能与故障边界**：按architecture §8统一场景测全进程树/Runtime内存和真实提醒调用p95；活跃模型不计入闲聊能力。若用户未授权真实通知/设备试用，只完成隔离自动验证并保留对应人工项，不能先勾验收。
- [ ] **最终差异和交付**：对照roadmap逐项勾已通过的项目，文档区分实现、替身测试、实机与未验证平台；保存脱敏证据，不上传凭证/用户数据。候选提交 `test: verify template companionship compatibility and delivery`；整个功能复核后再按届时授权决定提交/推送/打包。

## 计划自审与执行建议

覆盖映射：规则/模板→1；预算/设置/时间→2；定向权限/lease→3；协议/调度/手动/暂停→4；历史引用/墓碑→5；连接兼容/客户端期限→6；气泡/动作/入口→7；端到端、降级、资源与原生体验→8。所有公开DTO来自Task1，所有数值来源于协议v1；没有把每日简报或会话动态通知混入第一批。

推荐未来采用 **Native 顺序实施**：本批主要沿同一条状态链推进，任务之间共享类型、lease与引用边界，顺序接线更容易控制改动；最终再独立审查权限、恢复和兼容性。当前只交付计划，不启动任何实施技能，也不要求现在选择执行方式。
