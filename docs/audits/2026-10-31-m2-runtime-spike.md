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

## 结论

M2 底座代码与可自动化验证的出口项完成并有证据；M2 里程碑整体未完成——dsh spike 与安装器/性能验收是下一步硬 gate。
