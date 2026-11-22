# 工作日提醒改期验收

以 `fca2ba0` 为基线，验收「把每个工作日上午九点的休息提醒改到上午十点」。使用既有重复提醒改期授权。目标按系列 ID、版本和同名创建身份核验，工作日仍指规则时区内的周一至周五。[接入指南](../../README.md#weekday-reminder-reschedule) · [协议](../architecture.md#weekday-reminder-reschedule)

- 改期仅更新原规则的时刻与后续日期，SQLite 将规则、版本、额度和回执原子提交。旧工作日规则默认版本 1，原列表与存储行形状保持不变。
- 跨 SDK、CLI、MCP 并发重试返回首次回执。相同改期身份使用同一请求 ID 换周期或目标返回 409。旧版本不能改写，其他创建身份的规则不出现在目标列表。[跨入口回归](../../packages/cli/tests/weekday-reminder-reschedule-integration.test.ts)
- Runtime 验证通知在途与已认领日期、时钟回拨、夏令时缺失与重复、版本数据隔离、每日和工作日共用配额。版本、规则和回执作为一个事务提交。[调度与事务回归](../../packages/runtime/tests/daily-reminders.test.ts)

## 真实 dsh

Windows x64、Node 24.12.0、dsh 0.2.2-rc.1。在两个独立 profile 和 SQLite 目录中，用本地确定性 Provider 驱动 dsh 原生循环，经独立 stdio MCP 桥查询版本并改期。推进上海本地时钟，同时让每日对照规则在对应时刻投递。

| 工作日目标 | 周五 09:00 | 周五 10:00 | 周六与周日 | 周一 09:00 | 周一 10:00 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 九点认领前改期 | 0 | 1 | 0 | 0 | 1 |
| 九点投递后改期 | 1 | 0 | 0 | 0 | 1 |

两组改期都保留系列 ID，版本从 1 到 2。周五同一时刻重启后，等待新 Runtime 完成一轮调度再核对，确认零重投。原参数在重启及周一投递后仍返回首次回执。旧版本及复用请求 ID 换参数均返回冲突。既有每日改期也通过真实 dsh 回归，插件打包包含新的工作日改期 patch。

验收使用注入通知器。在线模型自主选工具、真实系统通知横幅及其他平台仍待验证。[dsh 说明](../../apps/dsh-plugin/README.md#让-dsh-改期工作日提醒) · [复验脚本](../../scripts/acceptance-dsh-reminder-weekdays-reschedule.mjs)

全仓构建、类型检查和按包串行测试通过，750 项通过，3 项按条件跳过。
