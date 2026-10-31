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

**卸载**：/S 卸载正常；运行中的 runtime 文件被锁残留，停止后可清除——正式验收需先提示退出再卸载。

## 结论（更新）

M2 出口项"安装包无须用户另装 Node"已有真机证据；**内存预算未达标并上升为架构决策点**。剩余硬 gate：dsh spike（本机未装 dsh）、外部记忆协议 spike（待用户提供服务端点）、内存口径决策。
