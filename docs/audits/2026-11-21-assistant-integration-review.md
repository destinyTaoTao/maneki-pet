# 共享助理接入与生命周期审查 · 2026-11-21

审查基线为 `6a47287`，实现截至 `5142543`。本轮沿外部调用方、共享 Runtime、模型服务和桌面展示四条路径检查已交付功能，使用独立 Windows x64 工作区、临时数据目录及合成凭证。参考的两个上游项目和取舍记录在 [README](../../README.md#设计参考与许可)。

## 发现与处置

| 触发条件 | 用户可见影响与修复 | 可复查的证据 |
| --- | --- | --- |
| 后台已经持有数据库锁，另一个 harness 启动原 stdio 入口 | 第二个进程会尝试再启动 Runtime。独立 MCP 桥现在通过 SDK 续租已有 Runtime 的状态；关闭桥后 CLI 和其他来源继续工作。配对仅签发 express，SDK 在同一 TCP 连接验证实例后才发送凭证。 | [第二进程集成测试](../../packages/cli/tests/state-integration.test.ts) · [SDK 身份及错误测试](../../packages/sdk/tests/expression-client.test.ts) |
| 更换对话服务端点，设置页留空密钥 | 旧实现会将上一个服务的密钥用于新端点。现在仅同一 origin 可沿用。设置提交后即使旧钥匙文件清理失败，运行中的请求仍按新设置失效，桌面提示用户检查目录权限。 | [模型设置与请求测试](../../packages/runtime/tests/assistant.test.ts) |
| Provider 清理、退出审计或启动收尾失败；多个调用者同时停止 | 旧实现会跳过余下清理，后来的调用者可能提前返回。现在共享停止结果，按阶段排空，数据库和实例锁最后释放。日志只记录失败阶段；已发出的提醒等到落库。 | [启动回滚、并发退出及重启](../../packages/runtime/tests/runtime-integration.test.ts) · [HTTP 排空](../../packages/runtime/tests/http-shutdown.test.ts) |
| 管理员通过通用客户端列表操作安装根身份 | 旧撤销路径可使唯一管理身份失效。现在返回 409，普通客户端仍可撤销；清单只投影身份、权限与时间字段。 | [管理接口鉴权矩阵](../../packages/runtime/tests/http-api.test.ts) |
| 多个表现来源共享一个客户端 | 同一次仲裁反复查询 SQLite。现在每轮按客户端核验，下一轮立即反映撤销。 | [来源与撤销回归](../../packages/runtime/tests/expression-state.test.ts) |
| dsh 事件没有项目目录；CLI 导出未发布的草稿 | 进程启动目录曾被当成项目名，导出调试日志也曾打印草稿标题。现在缺少目录时显示未知，CLI 日志省略草稿内容。 | [观察插件测试](../../apps/dsh-plugin/src/index.test.ts) · [草稿导出测试](../../packages/cli/tests/cli-entry.test.ts) |
| Windows 干净检出的文本为 CRLF | 原生依赖许可证校验误报正文漂移，阻断打包。生成器固定顺序和 LF 输出，验证只接受正文完全相同的整份 LF 或 CRLF。 | [生成器](../../packages/runtime/scripts/instance-lock-notices.mjs) · [发行布局实测](../../packages/runtime/tests/instance-lock-layout.test.ts) |

## 性能测量

使用 Node 24.12.0 x64、单个客户端、64 个有效租约和内存 SQLite。每次身份核验执行一条按主键查询；预热 25 次之后读取 1,000 次同步快照。前后运行使用同一脚本、数据库结构和租约。耗时为本机单次测量，受调度和 JIT 影响。

| 实现 | SQLite 查询 | 每次快照 p50 | 每次快照 p95 |
| --- | ---: | ---: | ---: |
| 基线 | 64,000 | 0.329 ms | 0.762 ms |
| 按客户端核验 | 1,000 | 0.011 ms | 0.024 ms |

回归测试同时覆盖两种身份和撤销后的下一次读取。数据描述的是仲裁热点；多宿主端到端吞吐、WS 广播、事件到视频首帧与空闲进程树内存仍沿用[架构预算及实机测量口径](../architecture.md#8-性能可维护性与验证)。

## 验证与边界

- `corepack pnpm install --offline --frozen-lockfile`、`corepack pnpm -r build`、`corepack pnpm -r typecheck` 通过。没有增加第三方生产依赖版本。
- `corepack pnpm -r test` 在启用隔离 Python 和本地词表的运行中 **644 通过、3 跳过**。三个跳过项为真实 Windows 通知、真实语音设备和两小时暖机。校验了两个开发占位包，本次没有导入两个可选角色包。
- 使用固定的本地 tokenizer 和临时 EverNook 库运行 `python -B -m pytest packages/adapters/evernook/tests -q -p no:cacheprovider`，**40 通过**。跨进程的三种模型配置联验均使用合成模型回复，覆盖保存、清历史、重启、召回、关闭对照和降级。
- README 架构图用 Mermaid 11.12.0 在本地 Chrome 渲染，核对了 12 个节点、11 条连线及中文标签。SDK、CLI、独立 stdio 桥和配对命令通过同一真实后台联验。
- 新客户端要求同版 Runtime 支持表达身份证明，旧版需一起升级；原 dsh 手工配置和进程内表达工具仍保留。独立桥只公布 `maneki_set_state`。对话、提醒及工程执行各有独立授权与验收。
- 本轮未发布安装包或 npm 包。真实麦克风与并发会话、休眠恢复、正式素材性能、macOS/Linux 和工程派发审批/恢复仍按[路线图](../roadmap.md)验收。
