# dsh 状态联动 MVP 验证记录

日期：2026-11-03。实现基线：`d1fd0ee` 后的本轮改动；契约先行提交 `ea37925`、`c678147`。关联 #3；此记录不关闭 #3、#11、#14、#15 或整个 M2/M2b。

用户于同日确认“先交付状态联动 MVP”，并确认使用 `d1fd0ee` 作为审查基线。本轮按此范围交付；任务与审批继续在 dsh 原生界面操作，宠物反向派发后续补齐。

## 已实现

- `apps/dsh-plugin` 显式订阅真实宿主 `session/event`，通过 DshAdapter 转换 turn/step/tool、审批等待与终态。失败、取消、中断不映射为完成；不转发提示词、工具参数、回答或项目路径。
- 宿主聚合最多 64 个活动会话；Runtime 聚合最多 64 个按客户端与插件实例隔离的表现租约，5 秒续租、15 秒失联回收。一个来源完成不覆盖其他来源的工作。断线不重放过时的庆祝/错误。
- `express` 客户端可通过 `/v1/expressions/state` 上报与查询表现；任务路由改为独立 `tasks` scope，旧表达凭证须显式重新配对才能获得任务权限，不自动提权。
- 桌面消费 `expression.state/say/play`，WS 就绪后读取当前状态；快照请求期间的新事件和新连接优先，旧快照不能覆盖。没有基于动画推进任务状态或队列。
- 修复原生壳 CSP 漏放本地 WebSocket：仅增加 `ws://127.0.0.1:18100`，没有放宽到任意地址或关闭鉴权。

## 自动验证

`pnpm -r build`、`pnpm -r typecheck`、`pnpm -r test` 在审查修复后全部通过（239 项：Core 91、desktop 38、dsh Adapter 22、Runtime 71、platform-core 8、bilibili 5、CLI 4）。新回归位于已确认的 Adapter 公共接口与 Runtime HTTP 边界：宿主事件、注销/取消、失败语义、权限隔离、多来源仲裁、凭证撤销和失联租约；真实 stdio MCP 与 HTTP/WS 同时接入的回归验证二者状态一致。

原生 `pnpm --filter @maneki-pet/desktop tauri build --no-bundle` 通过，生成当前 checkout 的 Windows release 程序。中途一次构建被运行中的测试 Runtime sidecar 锁文件阻止；退出本轮测试实例后重新构建通过，没有因此修改构建管线。

## 真实宿主与原生 WebView

环境：Windows、Node `24.12.0`、已安装 dsh `0.2.1-rc.5`。使用临时项目与单独配对的 express 凭证，不修改用户 dsh profile；插件通过本次调用的 `--patch` 加载。

1. 新建隔离任务，要求只回答 `MANEKI-DSH-MVP-OK`。宿主返回原文，鉴权 WS 捕获 `working → thinking → celebrating`；会话 `session-894e8450-f2cd-4dfc-be4d-d68c28bda185`。临时本机证据目录 `%TEMP%/maneki-dsh-mvp-f4auN2/evidence.json`。
2. 真实宿主运行无副作用的 `Start-Sleep -Seconds 15` 后回答相同标记。鉴权 WS 捕获 `working → thinking → working → thinking → celebrating`。最终直接使用仓库的 `observer.patch.example.yml` 验证通过；会话 `session-7e363b61-8156-421b-ad1a-49ab58b5318d`，证据 `%TEMP%/maneki-dsh-mvp-FvOH0A/evidence.json`。凭证在测试后撤销，测试宿主退出；没有停止其他宿主或操作其任务。
3. 原生 release WebView 最初显示连接断开，CDP `Log.entryAdded` 复现精确错误：本地 WebSocket 被 `connect-src` 拦截。增加固定 WS 地址后重建，原生 DOM 状态为 `已连接（127.0.0.1）`，同一日志探针无 CSP 违规。测试期开启的本机 CDP 端口只用于诊断，未写入程序配置。

自动 HTTP/Adapter 测试证明多来源、失联、等待/失败转换与清理语义；上述真实任务证明自然产生的宿主事件确实到达 Runtime。原生验证证明正式 WebView 能建立事件连接；本轮没有以此冒充所有动画状态的人工视觉验收。

## Standards

审查基线 `d1fd0ee`，规范与规格由两个独立上下文只读审查。

初审 2 项 P2：MCP 直接广播绕过新仲裁，使 WS 的 idle 与 GET 的 waiting_input 不一致，违反 §5.5 的状态仲裁要求；Adapter 未拒绝倒退事件，违反 §5.2。前者已统一 MCP/HTTP 租约与快照，后者已加入有界序列及已结束 turn 的水位。两项均先以公共接口复现失败，再修复通过。未发现需另报的基线代码气味。

复审确认两个原 P2 已解决，无新阻断项；独立复跑 Adapter 9 项及真实 stdio MCP＋HTTP/WS 1 项回归通过。Standards 当前未决缺陷 0，初审最高 P2 已修复。

## Spec

初审 1 项 P2：重复/迟到事件可重开已结束会话，违反“终态不能被迟到 progress 覆盖”。现已拒绝重复、倒退及更高序列的旧 turn 进展；下一个 turn 仍可被观察。未发现无关扩展；权限隔离、固定 WS CSP 与桌面事件消费均服务于当前链路。

复审无新阻断缺陷，Spec 当前未决实现缺陷 0，初审最高 P2 已修复。序列水位仅覆盖当前订阅最近 128 个会话，不声称可恢复已淘汰流或跨重启完整交付。原完整首版的审批、派发与恢复仍是已承认的剩余 gate，不能记为已完成或关闭 #3。

## 验证边界与下一步

- 本轮状态联动 MVP 的范围与审查基线均已获用户确认；这不等于原 M2/M2b 完整任务闭环出口通过，后续派发、审批与恢复仍按原门槛验收。
- dsh 默认工作区写权限与 Maneki 危险操作逐次审批要求仍需验证；本轮没有证明危险操作原生拒绝、无人响应、支付/强推等边界，不能声明 native 执行审批 gate 通过。
- 新任务派发仍拒绝，已有任务取消仍报告不可核实；没有伪造完整 TaskSnapshot、恢复交付或新派发授权。宿主重载期间已有工作的表现需下一条宿主事件重新建立，待机不证明外部任务停止。
- 没有 overlay、独立启动已安装 Runtime、安装器升级或全新 Windows 环境验收；安装版尚未更新。入口与配对步骤见 `apps/dsh-plugin/README.md`。
- 租约数、活动会话数与在途请求有界；没有测量本轮包含插件的全相关进程树资源和 p95，不复用旧资源测量作为本增量验收。macOS/Linux 未在本机验证。
