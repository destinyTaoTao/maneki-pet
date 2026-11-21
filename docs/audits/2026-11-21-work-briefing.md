# 开工简报与 dsh 接入验收

审查基线为 `ea5a67a`。本轮在 Windows x64、Node 24.12.0 上验证一个问题：用户授权后，personal agent 能否回答「哪些事已经到期、哪个会话现在等我回答？」。沿用已有待办和会话观察，用户按需查询。工程审批、个人数据写入和模型配置各有原有入口。[接入说明](../../README.md#让-personal-agent-帮你开工) · [HTTP 与授权契约](../architecture.md#work-briefing)

## 数据和授权

| 检查 | 验证结果 |
| --- | --- |
| 日期和隐私 | 切换上海与纽约时区，同一时刻选出的到期事项随本地日期变化。仅投影未完成且已有截止日的标题和日期，最多 8 项。读取前后个人数据版本、对话数和审计条数一致，未触发通知、模型、记忆调用或事件广播。 |
| 会话的时效和来源 | 只返回在线且处于等待输入阶段的会话。不同上报方即使提供相同来源和会话标识，也能按鉴权所得的 clientId 区分。在线来源截断、超过 8 项、租约过期和撤销各有回归。 |
| 接口权限 | 普通状态、个人助理及安装身份读取简报均被拒。简报凭证访问管理、写操作、聊天和订阅等路由均被拒。无匹配的 Runtime 身份证明时 SDK 终止请求，收到无效或超限的成功响应时报错。 |
| 丢失或误换配对文件 | 同一简报名称并发签发只有一次成功。服务端保留已登记名称，复用核对名称与 clientId。管理端可按登记名撤销，同名的其他权限或另一宿主仍可用。已启动的 SDK 和 MCP 在下一次读取时失权。 |

配对与撤销使用既有管理审计。简报读取不记录事项或会话正文。授权覆盖该 Runtime 中所有项目；外部 agent 可能把标题和项目名传给它采用的模型。[Runtime 回归](../../packages/runtime/tests/work-briefing.test.ts) · [观察来源回归](../../packages/runtime/tests/session-observations.test.ts) · [跨进程集成](../../packages/cli/tests/briefing-integration.test.ts)

## 真实 dsh 宿主

在独立的 `DSH_HOME`、profile、工作目录和临时 Runtime 中，运行 dsh `0.2.2-rc.1`、实际观察插件和宿主自带的 MCP 客户端。建立一个测试身份、一条逾期事项和一条未来事项。测试驱动发起合成 turn，由宿主的工具执行器运行内置的 `ask_user_question`，并控制回答时机。

1. dsh 发现的 Maneki 工具只有 `mcp__maneki__maneki_get_briefing`。问题等待回答时，简报返回一条逾期事项和测试会话，在线来源为 1。
2. 回答并结束 turn 后，在线来源仍为 1，等待列表变空。对相同 MCP 进程撤销授权后，再次读取返回工具错误。
3. 实测发现新版 Cordis 的卸载钩子需要注册 effect。修复后正常退出宿主会主动上报离线；异常中断仍由 Runtime 的 15 秒租约兜底。保留使用 dispose 事件的旧宿主路径。

构建仓库后，在安装了对应 dsh 的 Windows 机器上运行 `node scripts/acceptance-dsh-briefing.mjs`。也可将本机 dsh 的 `lib/bin.js` 路径作为唯一参数。脚本在临时目录生成合成数据，验证完成后回收 Runtime、宿主和凭证目录。[真实宿主验收脚本](../../scripts/acceptance-dsh-briefing.mjs)

本轮未调用模型，工具选择由测试驱动指定。自然语言选工具、管理弹窗、真实录音、macOS/Linux 和旧版 dsh 的新简报桥仍待单独验证。[dsh 配置与兼容范围](../../apps/dsh-plugin/README.md#让-dsh-读取开工简报) · [插件卸载用例](../../apps/dsh-plugin/src/index.test.ts)

## 工程门禁与并发采样

- `corepack pnpm -r build` 通过。首轮包间并行测试中，两项启动多个 Node 子进程的既有管理/凭证用例超过 5 秒阈值，其中一项清理临时目录时报 `ENOTEMPTY`。两个测试文件单跑 10/10 通过。保留原超时和断言，按包串行运行 `corepack pnpm --workspace-concurrency=1 -r test`，658 项通过，3 项按条件跳过（原生通知、真实语音设备、两小时暖机）。全仓类型检查通过。此次使用已准备的本地词表运行了 3 项 EverNook 隔离集成。
- Windows 回环采样使用一个临时 Runtime、200 条合成到期待办、零个观察来源和 16 个分别配对的 SDK 客户端。每个客户端先读取两次预热，再以 16 个并发请求为一批，共读取 320 次，逐次校验 8 条结果及截断标记。含身份校验的 SDK 调用 p50 为 19.7 ms，p95 为 23.6 ms，最大 24.9 ms。生产者与消费者在同一 Node 进程内经真实 HTTP 通信；桌宠动画、真实模型、持续压测不在此采样范围。
