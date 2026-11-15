# 项目审查、修复与待确认清单（2026-11-15）

基线：本地 `main` 的 `78550f3`。本轮授权为全项目审查、修复高确信度问题、验证并提交本地 main；不推送、发布、安装替换、真实休眠或调用付费云服务。结论针对当前源码和本机 Windows，不能证明不存在其他缺陷。

## 范围与方法

先核对根规则、GLOSSARY、roadmap、architecture、ADR 和相关验收记录，再沿调用链审查一方实现、测试、配置及维护脚本。三个独立 reviewer 分别覆盖桌面、Core/适配器/CLI、语音/传输，主审覆盖 Runtime 主会话、存储、提醒、观察和轻陪伴。部分长 Runtime 测试文件仅核查相关断言/场景，不声称所有测试逐行通读；全仓门禁另行执行。修复先建立故障回归，再核对修改后的行为；完成前另外进行修改范围只读复核。

| 范围 | 实际覆盖 | 证据边界 |
|---|---|---|
| Core | 动画、个人事项解析、上下文/预算、记忆、陪伴、语音及 Task Broker；源码/测试/配置 | 派发 gate 保留；不把纯规则测试当宿主执行验收 |
| Runtime | 装配/鉴权/HTTP/WS/生命周期，SQLite/迁移、主会话/引用/设置、提醒/预算、观察、陪伴，模型/ASR/TTS/宿主语音、MCP | 使用内存库或临时独立身份、回环替身；未读写正式个人数据 |
| Desktop | 全部一方 TS/JS/Rust、CSS、测试，动作包配置/制作/导入/校验脚本与配方 | 上游 NSIS 模板只检查 Maneki 定制位置；不逐字审生成媒体/上游代码 |
| dsh | 插件入口/观察/管理/宿主语音、传输、测试及构建 | 不启动真实 dsh 工程任务，不代批原生配对 |
| 其他适配器/CLI | dsh、platform-core、Bilibili、EverNook Python、Schema、草稿/备料/证据回流、离线抖音诊断 | 不发布平台内容、不访问正式记忆；Python owning API 只读核对本机 EverNook checkout |
| 工程/文档 | workspace/TS/package 配置、发布和 Windows 验收脚本、README/路线图/架构及已有审计 | 未发现 CI 配置；不升级依赖。锁文件、依赖、编译产物和媒体无需逐字读取 |

原有 `apps/desktop/public/packs/ASSET-LICENSE.txt` 与 `.playwright-cli/` 不属于本轮，不覆盖、清理或提交。许可文件开始时 SHA-256 为 `722303A6FB57F52AB738B3C9FF0F1D987543AF4DE4B3652095B74FA6DAF4EB06`。

## 已修复

| 编号 | 触发、根因与影响 | 修改与回归证据 |
|---|---|---|
| F1 · P1 管理凭证连接绑定 | `openAdminSession` 只校验初次 health，后续 fetch 可换连接。合法服务校验后退出，同端口另一监听者能收到 root；隔离探针只使用合成密钥 | `runtime/src/admin-session.ts` 每次管理请求重新 challenge/HMAC/版本/实例核验，只在该次已核验 socket 上发凭证和正文，结束销毁连接；保持错误码和 CLI 形状。新增端口易主、health 关连接、实例/版本变化、JSON/大小/超时等回归；先有 5 项失败，再通过 |
| F2 · P2 摘要漏历史 | `context-window.ts` 先摘要被丢弃前缀，再为摘要自身腾位丢掉更多历史；后者既没保留也没传给摘要器。`a×20,b×20,c×10` 的例子可复现漏掉 b | 单调扩大摘要前缀、重新摘要；所有历史纳入仍超限则拒绝，有界结束。新增 2 项先失败后通过；未改变 truncate/reject 策略 |
| F3 · P2 视图静默创建凭证 | 右键/设置/形象入口经 `open→connect(true)` 创建 `assistant,settings` 个人凭证，违反架构 §3.1 的视图授权边界 | `desktop/src/main.ts` 和 `assistant-panel.ts` 对视图只尝试 existing 凭证；显式打开助手仍可授权，覆盖并发复用失败后显式创建。未配对形象/侧栏仍可打开；新增回归先有 2 项失败 |
| F4 · P2 首次加载/换包丢表现状态 | Runtime 快照先于素材加载时 `setState` 被丢弃；换包也重建 idle，掩盖 working/waiting | `desktop/src/player.ts` 保存最近状态，创建新动画链后重算；不重放短动作，缺状态仍由 Core 回退。3 项新增播放器测试在旧代码均失败，修改后通过 |
| F5 · P2 记忆输出无界 | MCP 子进程持续输出无换行字符串会不断累积缓冲；超大完整帧也无检查 | `runtime/src/mcp-memory-client.ts` 在拼接/解析前检查每帧 4 MiB UTF-8，超限结束子进程、释放缓冲并使调用降级；写入仍为结果未知、不重放。4 项超限红测，另验连续合法小帧总量超过 4 MiB 不被误拒 |
| F6 · P2 非法记忆不降级 | MCP 只做类型断言，Core 在 try 外读取条目；`items:[null]` 逸出 TypeError，未知 source 被当 implicit，非字符串正文也可进入上下文 | MCP 与 Core 各自验证外部边界的 id/text/source，非法结构以固定原因降级，不回显内容。Core 5 项及跨子进程 3 项回归先失败后通过 |
| F7 · P2 草稿无法继续备料 | 交互 draft 输出裸草稿，package 只读取 `{draft}` 信封，导出在读取 title 时失败 | `cli/src/main.ts` 的 package 兼容两种现有形状，保持交互输出；真实 CLI 子进程测试两格式均导出合成文件 |
| F8 · P2 运营指标未采集 | `captureOpsData` 校验 JSON 后只把本机路径传给 shim，任何播放/点赞等指标均未进入回执 | `cli/src/platform-commands.ts` 沿既有附件接口传完整已校验 JSON，保留 manual-export，限制 ≤1 MiB。mock 检查所有指标/来源及无效数据调用前拒绝，不写真实账本 |
| F9 · Python 测试夹具漂移 | 当前 EverNook conformance 要求独立可信 profile fixture；旧测试丢弃 initialize 返回的 owner，只传 adapter，出现 5 通过/1 失败 | 仅更新本仓合成临时夹具，沿 owning suite 参数传独立 owner/runtime；适配器仍持 recall/capture，不放宽断言或生产权限。该 suite 不覆盖 JSON inject 的可调用性，见 C2 |
| F10 · 文档状态漂移 | roadmap 顶部说轻陪伴未实现、实现清单未勾选；README 把四阶段均称待验；架构轻陪伴段落仍称只确认设计 | 按 `78550f3` 的实现及已有验收记录同步实现状态、前两阶段和当前动画数；实机/整体出口保持独立，历史审计不改写 |
| F11 · P2 慢请求阻止退出/退出后仍写 | settings 客户端发送不完整 HTTP body，11 秒后 Runtime 仍为 stopping、实例锁未释放；退出后补齐 body 仍可写 dnd 并返回 200 | `runtime/src/http-api.ts` 停止接入并在异步读 body 后复查停止状态，最多 1 秒排空 HTTP 连接；`runtime.ts` 在清理 Provider 前启动 HTTP 关闭。新增 2 项先失败后通过；管理退出原 200 回执保留 |
| F12 · 跟踪了生成缓存 | 5 份 Python `.pyc` 已进入 Git，运行测试会改脏工作区；根 `.gitignore` 已排除该类产物 | 仅从索引移除这 5 份生成缓存，保留本机文件，不删除源码/测试或改 ignore；Python 3.14 会按需重建，不影响模块装载 |

安全/资源边界先行文档提交：`31a5ac7`；有界 HTTP 退出约束先行提交：`07c8239`。无新增生产依赖、数据库迁移或已发布请求格式变更。超大 MCP 响应服务需在来源侧减少单次返回内容；正常消息及 JSON shim 契约保持兼容。

## 初次审查的待决快照

以下 C1/C2 的“未修”针对 `295f54b` 初次审查结束时。用户随后已确认三项方向并授权连续实施、本地 main 提交；后续实施与验收状态见文末，不再重复请求确认。

### C1 · P1 崩溃锁并发回收（已确认，未修）

证据：`packages/runtime/src/lifecycle.ts` 的两个 stale-lock 分支均是“检查死 PID → unlink 路径 → wx 创建”。A 检查后，B 可先获取新锁，随后 A 删除 B 的锁而成功获取；`release()` 也未检查归属。两个启动者可同时认为持锁。固定端口通常还会阻止第二个监听，但失败清理又可能删掉存活锁。没有证明已发生重复通知或数据库损坏，不据此夸大后果。

可复现：先构建 Runtime，再运行 `node packages/runtime/tests/fixtures/instance-lock-recovery-race.mjs`，输出 `concurrentOwners:true`。探针只在当前进程替换 fs 函数、使用临时目录，确定性模拟合法调度顺序，不测量真实发生概率，不加入永远失败的测试门禁。

为什么未修：重读 UUID/stat 后 unlink 仍有相同竞态；再加一个可回收文件锁只是搬移问题。可靠方案涉及 OS 持有型锁或成熟 native 依赖，或者改变“崩溃自动恢复”的产品行为。

建议及需决定：优先采用崩溃后由内核释放的 OS 锁，Windows 先验收，其他平台单列。请决定是否授权引入受信 native 桥/依赖；若暂不引入，是否接受检测死锁即保守拒绝并要求明确离线恢复。决定前不扩大日常/发行准入。

### C2 · P2 EverNook 注入协议与参考时间（已确认，未修）

证据：`packages/adapters/evernook/maneki_evernook_adapter/cli.py` 把 JSON `counter` 原样传给 `ContextBuilder`，而当前 owning 实现需要 `.counter_id` 与 `.count(text)`。纯内存调用得到 `AttributeError: 'dict' object has no attribute 'counter_id'`。`surface.py` 又固定 `as_of=2026-10-30T12:00:00+08:00`，mock 已确认；owning recall 用它决定近期窗口和事实有效性。

为什么未修：JSON 不能携带 Python tokenizer 方法；需要明确受信 tokenizer ID、本机模型/版本映射及计数不可用时的失败方式。时钟还需区分日常当前时间与可复现回放，不能用任意字符计数冒充真实 tokenizer。

另有诊断入口边界：CLI `conformance` 仍仅构造 `ConformanceSuite(surface)`，没有独立可信 profile fixture，会按当前 owning suite 明确失败；Python 测试已补合成 owner 不等于可给生产适配器管理员权限。后续应提供只针对隔离临时身份的诊断夹具入口，不从正式配对凭证推断维护授权。

建议及需决定：在 #67 的主会话记忆接入设计中先固定目标 tokenizer/model，由 shim 白名单解析本地实现；正常召回使用当前 UTC，可注入时钟仅作测试/明确回放。请确认目标模型与可用 tokenizer，以及是否提供显式历史回放参数。完成前不宣称 JSON inject 或次日召回可用。

### C3 · 新素材的发行晋升（发布选择，非缺陷）

当前本地源码包为橘/白/黑 `2.0.0`；`scripts/release-windows.mjs` 仍以已批准的 `orange-catgirl-delivery-v1.1.0.json` 作发行指纹门禁。未绕过或替换该门禁。待新素材观感/资源验收后，再决定是否晋升三色包、更新发行版本与指纹并制作新包；本轮不重新封装/覆盖 alpha.2。

## 仅待实机验证及后置范围

- 轻陪伴：真实挂起/恢复后的旧租约失效；修复后的右键、设置、命中和暂停提示；真实两小时暖机/间隔、双端与语音/提醒交互。
- #66：最终安全代码上的真实 dsh 授权/选择/失联/恢复、麦克风成功识别与录音期间 B 完成的同一轮组合、取消与朗读打断。
- #67：解决 C2 后，以独立身份显式保存/回执、排除本地历史和摘要的次日跨项目召回及关闭召回对照。
- 性能：全进程树 Private Bytes ≤300 MiB、Runtime ≤75 MiB；事件到视频首帧 p95<300ms、提醒到通知调用 p95<1s；活跃语音资源与冷/热启动单列。本轮只消除已证无界缓冲，未测真实长期性能，不宣称预算通过。
- 原有安装迁移、原生权限、通知展示、多屏/DPI、macOS/Linux 分别验收。工程派发/代审批保持关闭；第二宿主、overlay、常开麦克风、画像、平台发布等继续后置。
- 未发现可直接删除且有充分证据的剩余功能/测试；已关闭的派发代码与平台备料有文档用途，不因近期未启用而删除。未测量的“低效”不凭直觉改写或升级依赖。

## 实际验证与提交

本机 Windows，Node 24.12.0、pnpm 11.25.0、Python 3.14.4。基线 `pnpm -r build` 和 `pnpm -r test` 通过（530 通过、3 跳过）；修改前故障回归的预期失败见上述记录。最终检查如下：

| 检查 | 实际结果 |
|---|---|
| `pnpm -r build` | 通过 |
| `pnpm -r test` | **569 通过、3 跳过**；Core 116、platform-core 8、dsh adapter 22、Bilibili 5、插件 19、CLI 8、Runtime 248、Desktop 143。四个本地动作包校验通过 |
| `pnpm -r typecheck` | 所有 workspace 包通过 |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | **8 通过、1 忽略**；忽略项为需人工真实休眠的探针 |
| `C:/maneki-lab/venv-py314/Scripts/python.exe -B -m pytest packages/adapters/evernook/tests -q -p no:cacheprovider` | **6 通过**。首次 5 通过/1 失败已通过独立夹具修正，未削弱断言；不代表 JSON inject 或完整记忆链路通过 |
| `pnpm --filter @maneki-pet/desktop tauri build --no-bundle` | Windows release 原生构建通过；仅生成未打包程序，未运行/安装/替换或发布 |
| 最终 diff 与既有文件 | `git diff --check` 通过；原许可文件 SHA-256 与开始时相同，`.playwright-cli/` 不纳入；5 个 `.pyc` 从跟踪移除但本机文件保留 |

三项跳过为真实 Windows 通知、真实语音设备、手动启用的两小时暖机观察；真实系统休眠、设备及主会话次日记忆等均未运行。安装/升级脚本仅审查，未运行；付费云调用、真实平台发布和跨平台设备验证未执行。

本轮按独立意图提交本地 main：`31a5ac7`/`07c8239` 为先行架构约束；`645b75e` 移除缓存跟踪；`61be372` 管理连接；`c6d2f1b` HTTP 退出；`d1e73a3` 摘要；`e82d2cc` 记忆边界；`ef6cadd` 视图凭证；`25871db` 播放状态；`6f481d8` 草稿；`332b26d` 指标附件；`3726e5c` Python 夹具。本文、复现探针和状态同步另作收尾提交。未推送、部署或发布。

## Standards 独立复核

独立 reviewer 未发现本轮新增硬规范违规。管理凭证逐次核验并绑定同一 socket，连接与超时有清理；HTTP 关闭后阻止迟到写入；Core 未引入 IO 依赖，公共请求形状及权限边界保持兼容。MCP/Core 的重复校验分别保护传输与领域边界，暂不抽共享；摘要重算单调扩大且有界，无须新增抽象。最终移除已跟踪生成缓存的问题已处理。

已考虑而保留：锁回收、Python 注入和 CLI conformance、实机与发行门槛是既有未决项，本轮未见恶化。判断为本轮可完成门禁与本地提交，不代表整体产品验收。

## Spec 独立复核

独立 reviewer 未发现本轮新增确定性需求缺陷或范围扩大。对照 architecture §2.3、§3.1、§4.1、§4.4、§6.1、§10.3，partial body 关闭后禁止写入、同 TCP 身份验证、摘要前缀扩大、MCP 帧限额/写入 unknown、视图复用并发、换包保留状态、CLI 两格式/完整附件和 Python 独立 owner 均符合修复范围。

已考虑而保留：锁/注入/发行涉及依赖或产品决定；实机性能和跨平台缺运行证据，审计与路线图未把它们算作通过。reviewer 为只读核查，未代跑门禁。

两轴结论：Standards 新增确认问题 0，Spec 新增确认问题 0；各轴无新增最严重项。C1/C2 的既有已确认问题继续保留。

## 隔离探针清理限制

自动审批拒绝了删除 `%TEMP%\maneki-review-admin-7B4r9a` 的动作，返回原因仅为 `blocked by policy`。已停止该清理，没有换方式绕过；目录仅含本轮探针的合成测试凭证，不含正式用户数据。仓库修复及验证不依赖删除它；残留明确交由用户后续处置。

## 用户确认后的实施增量（2026-11-15）

范围基线为 `295f54b`。用户批准：Windows 优先、Runtime 自身持有 OS 锁并保留崩溃恢复；显式记忆最小主会话闭环、真实模型匹配 tokenizer、当前 UTC；三色先验收后随下一 Windows 预览晋升。只提交本地 main，不推送、发布或替换安装。先行契约提交为 `1e62ffb`、`9307d46`。

### 单实例锁

`f9edd10` 引入受信 Node-API 原生桥：Windows 文件句柄直接位于 Runtime 进程，不依赖辅助进程存活。取得排他权限后读取元数据；正常关闭在持句柄时标记删除，异常终止由内核释放。未取得所有权的对象释放不影响真正 owner；旧版仍存活 PID 保守拒绝，新版残留不以回收 PID 判所有权。真实多进程竞争、强杀恢复、独立目录、失败释放、旧 PID 与无窗口发行布局均有回归。真实八启动者探针只有一个 owner。

源码组合构建新增 Rust ≥ 1.88 / MSVC 要求，napi-rs/windows-sys 版本与许可锁定；生成 `.node` 纳入 Runtime bundle 和桌面资源。缺少模块拒绝启动，不回退有竞态的 unlink 锁。**本轮仅 Windows x64 原生实现，macOS/Linux 不提供可用锁实现，启动明确拒绝**。空残留和完整新版记录可自动恢复；非空损坏/半 JSON 仍保守拒绝，不宣称任意掉电损坏恢复。

### 显式记忆

新增默认关闭的独立保存/召回设置及空 body 显式配对路由。普通读取、启动和聊天均不创建配对或恢复撤销的权限；保存仅认当前输入的“记住：…”前缀，以 EverNook 原文回执及来源为准，敏感投影不声称原文保存。主会话持久请求 ID 去重，未知结果不换 ID 重放。Python CLI 旧 JSON `{policy,counter}` 改为严格 v1 `{protocolVersion,query,model,tokenLimit}`，内部 Python 对象 API 保留；迁移细节见[适配器说明](../../packages/adapters/evernook/README.md)。SQLite v6 无迁移；旧客户端省略 memory 保留，新字段被旧 Runtime 丢弃后再升级默认关闭。

真实 tokenizer 使用显式安装的 tiktoken 0.12.0 与哈希核验的本地 o200k_base 词表，仅接受已列白名单的 gpt-4o / mini 及快照。不自动选模型、下载词表、联网回退或用字符数冒充；无模型/缺词表/未知模型跳过召回并提示。召回只查当前输入、使用当前 UTC，结果作为不可信 user 数据纳入同一输入预算，来源只取实际注入项。保存不依赖模型/tokenizer；设置变更、清历史、撤销及停止中止在途子进程，丢弃迟到结果。错误不回显 stderr、凭证、路径或记忆正文。

隔离真实库联验：显式配对→保存唯一合成偏好→清小招历史与摘要→停止/重启 Runtime→真实 shim/tokenizer 召回并带来源；关闭召回且再次清历史时不注入；缺 Python 时普通聊天及 100ms 合成提醒仍工作。对话与通知为本地替身，不使用正式个人库或计费 Provider。测试依赖仅放本仓忽略的 `dist/memory-python` / `dist/memory-tokenizer-data`，未改变共享 venv 或 EverNook owning repo。

独立全变更评审发现 1 个 P2：取消/重启覆盖已发出保存的未知状态，且仅保留 code 时新窗口无法感知。已按同一根因修复：发起前持久标记，取消先事务记录未知再 abort；当前历史中的在途保存恢复时生成固定核实提示并绑定原请求，新窗口沿用历史展示，不增加快照字段或新确认流程。清历史保留请求去重/未知 code，但不重建提示；重复恢复和迟到回执不追加历史。六种路径及真实 SQLite 重开先红后绿，另验证新 panel 无内存 ownRequest 仍展示恢复提示。取舍是复用现有持久消息；若遗漏会误导用户重发或复活已清历史，回归覆盖了这两项风险。

最终独立定向复核通过：上述唯一 P2 已闭环，未发现新的阻断问题。单实例锁已有独立 Spec/Quality 复核；全变更只读评审除该 P2 外未确认其他缺陷。reviewer 未代跑门禁，根任务实际执行如下（Node 24.12.0、pnpm 11.25.0、Python 3.14.4、Rust 1.99.1，Windows）：

| 最终检查 | 实际结果 |
|---|---|
| `pnpm -r build` / `pnpm -r typecheck` | 全 workspace 通过，最终修复后重跑 |
| `pnpm -r test` | **621 通过、3 跳过**；Core 116、platform-core 8、dsh adapter 22、Bilibili 5、插件 19、CLI 8、Runtime 298、Desktop 145；四个本地动作包校验通过 |
| 真实记忆跨包联验 | 显式设置 `MANEKI_MEMORY_TEST_PYTHON` 与 `MANEKI_MEMORY_TEST_TOKENIZER_DIR` 后纳入上述 Runtime 门禁，**1 通过**，未跳过；同进程继承隔离 tokenizer/shim `PYTHONPATH` |
| Python pytest | **30 通过**（41.35s），禁用字节码及 pytest 缓存；使用本仓隔离 tiktoken/词表，未操作正式库 |
| `conformance --isolated` | **7 检查通过**，输出 `isolated:true` / `synthetic_contract_only`；该 counter 不冒充真实模型 tokenizer |
| native instance-lock Cargo test | 编译/执行通过；Rust 单测为 **0**，真实锁行为由 TS 多进程与 bundle 测试覆盖，不将 0 项说成行为验收 |
| 桌面 Cargo test | **8 通过、1 忽略**；真实睡眠探针未运行 |
| `pnpm --filter @maneki-pet/desktop tauri build --no-bundle` | 最终修复后通过；输出 `apps/desktop/src-tauri/target/release/maneki-desktop.exe`，附带 Runtime bundle 与原生锁资源，未运行、安装或封装新发行包 |
| 最终 Diff / 既有改动 | staged/工作区 `diff --check` 通过；既有 ASSET-LICENSE.txt SHA-256 仍为 `722303A6FB57F52AB738B3C9FF0F1D987543AF4DE4B3652095B74FA6DAF4EB06`；该文件及 `.playwright-cli/` 不纳入提交，发行脚本/批准素材指纹未改 |

3 项跳过仍为真实 Windows 通知、语音设备与两小时暖机观察；真实休眠、计费模型、跨天效果、原生观感、长期资源、其他平台未运行。日志保留在 `%TEMP%/maneki-final-{build,test,typecheck,tauri}.log`、`maneki-memory-python-final.log`、`maneki-{lock,desktop}-cargo-final.log` 与 `maneki-conformance-final.log`。

后续实施按意图提交本地 main：`f9edd10`（OS 锁）、`7a5445b`（Python 协议/权限/离线 tokenizer）、`bdca6ed`（Runtime 记忆接入与未知写入恢复）、`f5ace30`（桌面授权/配对与提示）。本审计、计划状态及配置说明另作收尾文档提交；不推送。未新增未处置的确认缺陷或暂缓小项，实机范围保留如下。

### 最后需要实机确认

- 在新构建的原生助手设置中配置受信 Python、独立 EverNook 测试库与配对路径，显式配对；按所选真实对话模型准备受支持的本地 tokenizer。当前默认安装未选择模型，本轮未替用户选择或调用付费服务。
- 独立身份保存唯一偏好并核对回执；清本地历史/摘要后，真实次日换项目召回，对照关闭召回并核对来源、实际回答及未知结果提示。清小招历史不会删除 EverNook 副本；删除长期记录须在 EverNook 处理。
- Windows 原生配对、配置保存、取消/退出、原生权限及实际通知展示；#66 真麦克风/扬声器与并行会话组合；轻陪伴真实休眠/恢复、两小时暖机、双端/提醒/语音互让。
- 橘默认、白黑可选的 27 段动画/20 项点播动作：透明边缘、动作衔接、控制条/气泡、多屏 DPI 与真实资源采样；全树 Private Bytes ≤300 MiB、Runtime ≤75 MiB，事件到动画 p95<300ms、提醒到通知调用 p95<1s。自动结构检查不替代此验收。
- 三色通过后才更新下一预览的发行版本与批准指纹；本轮不运行 release/安装替换，alpha.2 封存包不改。跨平台、长期性能、真实模型行为与所有阶段整体出口均未验收。
