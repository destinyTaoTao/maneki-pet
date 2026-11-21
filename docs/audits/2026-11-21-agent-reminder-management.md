# 外部 agent 查询和取消提醒

以 `ef014df` 为基线。本轮验收「帮我看看还有哪些提醒，把刚才那个休息提醒取消掉」。查询、取消分别使用独立凭证，均绑定同名的创建身份。查询返回尚未开始投递的自有记录。本人在桌面安排的提醒和其他 agent 的提醒仍由各自入口管理。[接入指南](../../README.md#agent-reminder-management) · [接口契约](../architecture.md#agent-reminder-management)

## 对抗式回归

| 场景 | 验收结果 |
| --- | --- |
| 越权与独立撤销 | 创建、查询、取消分别配对。查询只显示该身份的记录，取消其他身份的记录与目标不存在返回相同的 404。撤销取消权限后，原来的查询客户端仍可读取自己的待投递列表。 |
| 同名与过期版本 | 两条「休息」按 ID 分开。精确取消其中一条，另一条仍可调度。本人修改后的旧版本及正在投递的记录拒绝取消。 |
| 回执丢失和重启 | 同一请求 ID、目标和版本重复提交返回首次回执。并发调用只移除一条记录。成功后用原请求 ID 改成另一条提醒返回 409。 |

提醒归属取自此前已提交的创建回执，升级前由外部创建接口保存的记录仍可操作。取消与调度认领共用 SQLite 事务边界。调度先认领时返回冲突，由系统继续该次投递。损坏的创建回执不能证明归属。列表最多返回 200 条，查询通过创建身份索引读取历史回执，成本仍随单个身份的历史量增加。[Runtime 回归](../../packages/runtime/tests/agent-reminders.test.ts) · [跨入口回归](../../packages/cli/tests/reminder-management-integration.test.ts)

## 真实 dsh 宿主

在 Windows x64、Node 24.12.0、dsh 0.2.2-rc.1 的隔离 profile 中加载三个真实 stdio MCP 桥。用本地确定性测试 Provider 驱动 dsh 原生对话循环，由上一轮创建回执和当前列表选中「刚才那个」。错误版本与相同请求 ID 改目标均返回 409，原参数重试返回原回执，撤销取消后查询仍成功。

dsh 退出后，使用同一 SQLite 重启 Runtime，并推进测试进程的时钟到期。注入通知器只收到保留下来的同名提醒，取消的目标未触发投递。本轮取消验收使用注入通知器，Windows 原生通知的创建链路另有上轮实机记录。在线模型自主选择工具及其他操作系统仍待单独验证。[dsh 使用指南](../../apps/dsh-plugin/README.md#让-dsh-查询和取消自己安排的提醒) · [复验脚本](../../scripts/acceptance-dsh-reminder-management.mjs) · [Windows 原生投递记录](./2026-11-21-agent-reminders.md)

全仓 `corepack pnpm -r build`、`corepack pnpm --workspace-concurrency=1 -r test`、`corepack pnpm -r typecheck` 通过。683 项测试通过，3 项按条件跳过。原有 dsh 简报验收与提醒创建跨入口回归也通过。
