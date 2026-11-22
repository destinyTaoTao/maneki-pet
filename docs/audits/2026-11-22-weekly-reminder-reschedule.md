# 指定星期提醒改期验收

以 `248fefb` 为基线，验收「把每周一、三、五上午九点的休息提醒改到上午十点」。改期沿用独立的 `reminder_recurring_reschedule` 和同名创建身份。Runtime 在同一 SQLite 事务中更新原系列的时刻、日期、版本、额度和回执。目标和回执都带有升序的 `daysOfWeek`。[接入指南](../../README.md#weekly-reminder-reschedule) · [契约](../architecture.md#weekly-reminder-reschedule)

## 真实 dsh

Windows x64、Node 24.12.0、dsh 0.2.2-rc.1。隔离 profile 以本地确定性 Provider 驱动两轮原生对话，经实际 stdio MCP 查询版本和改期。存在时刻、正文相同的周二与周四系列，两轮均按星期集合选中周一、三、五系列并保留时区。每次推进模拟时钟都等待调度扫描结束，同一时刻的每日对照用于核验实际执行。

| 上海本地时间 | 目标系列 09:00 调用数 | 目标系列 10:00 调用数 |
| --- | ---: | ---: |
| 11 月 23 日周一，九点前改期 | 0 | 1 |
| 11 月 24 日周二 | 0 | 0 |
| 11 月 25 日周三 | 0 | 1 |
| 11 月 27 日周五，九点已认领，九点半改期 | 1 | 0 |
| 11 月 30 日周一 | 0 | 1 |

周一和周五在十点原时刻重启均为零次。MCP 重试和重启后的 SDK 重试都返回首次回执，旧版本的新请求返回 409。验收使用模拟时钟和注入通知器。在线模型自主选择工具、系统通知横幅及 macOS/Linux 实机体验待单独验证。[dsh 接入](../../apps/dsh-plugin/README.md#让-dsh-改期指定星期提醒) · [复验脚本](../../scripts/acceptance-dsh-reminder-weekly-reschedule.mjs)

## 契约回归

- API、SDK、CLI 和 MCP 并发改期都得到同一份版本 2 回执。相同请求 ID 换周期或系列冲突，其他创建身份的系列不可查询和改期。撤销改期能力后创建权限仍可查询原列表。[跨入口回归](../../packages/cli/tests/weekly-reminder-reschedule-integration.test.ts)
- Runtime 回归覆盖旧规则版本 1、原时区不随默认设置变更、时钟回拨、通知在途、夏令时缺失和重复分钟、取消后重放、跨周期共用限额和回执写入失败时的事务回滚。[调度回归](../../packages/runtime/tests/daily-reminders.test.ts)

全仓构建和类型检查通过。首轮全仓测试中，Windows 实例锁用例的动态端口被 Node `fetch` 拒绝（`bad port`）。完整复跑通过，771 项通过，3 项按环境条件跳过。每日改期、工作日改期和指定星期创建到取消的既有 dsh 脚本均通过，插件打包清单包含指定星期改期 patch。
