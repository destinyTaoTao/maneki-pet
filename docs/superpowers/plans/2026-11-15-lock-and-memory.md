# Runtime 锁与显式记忆接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. 用户已授权连续执行并提交本地 main，无需再次确认方向。

**Goal:** 先修 Windows 单实例锁，再完成受限的 EverNook 显式记忆闭环；三色素材只准备验收。

**Architecture:** 以 docs/architecture.md 为权威；锁用 Runtime 进程直接持有的 OS 文件句柄，记忆仅经受信 Python shim 及独立授权，故障不阻塞原有能力。契约先行单独提交，源码按根因红绿验证。

**Tech Stack:** TypeScript/Node 24.12.0，现有 Rust/Cargo，napi-rs，Python 3.14/EverNook。

**Spec:** docs/architecture.md §2.3/§4.4/§10.3；用户本聊天已批准 C1/C2/C3。

## Global Constraints

- 仅本地 main 提交，不 push/发布/安装替换；保护既有许可改动和 .playwright-cli/。
- 不使用正式个人数据、真实睡眠/麦克风/计费 Provider；不清理已被拒绝的临时目录。
- Core 无 IO；提醒、文字和语音分别独立；记忆仅显式保存、来源可追溯，无静默回退或下载。
- 三色候选观感/资源待实机，旧发行指纹和 alpha.2 保持，后续随下一预览晋升。

## Review Focus

- 真正多进程 OS 排他、失败对象 release 不解锁他人、崩溃后自动恢复、独立配置隔离。
- Node 原生模块在源码、dist、自带 Node 的无窗口发行布局均可装载，缺失拒绝。
- 显式记忆写入结果未知不重放，未配对/权限拒绝不能被自动授权掩盖。
- tokenizer 必须匹配实际消费模型；缺失/失败跳过召回，不能假计数或执行动态路径。
- 关闭/失联、清历史后真实召回与无召回对照，不能以本地摘要假冒长期记忆。

### Task 1: Windows OS 单实例锁

**Files:** runtime/src/lifecycle.ts，runtime/native/instance-lock/，runtime/scripts/build-instance-lock.mjs，runtime/scripts/build-runtime-bundle.mjs，desktop Tauri 资源配置，runtime/tests/lifecycle 与多进程/布局回归。

**Interfaces:** 保留 InstanceLock.acquire()/release() 和 LockBusyError；native 持有 File 句柄、有限读取/写入元数据、显式关闭。锁路径沿用配置目录。

- [x] 写多进程/失败释放红测；旧故障探针保留在 `295f54b`，当前探针改为真实八进程竞争/恢复检查。
- [x] 实现 native 和固定加载/构建/发行布局；旧 PID 兼容检查在 OS 排他权限内完成。
- [x] 真实竞争、正常退出、异常终止、别名/独立目录、旧存活者、缺绑定、bundle Node 回归。
- [x] 独立只读评审、修复复测、分意图提交（`f9edd10`）。

### Task 2: 记忆契约及最小主会话闭环

**Files:** Python shim surface/CLI/tests，Runtime 设置/记忆服务/主会话，Desktop 设置和提示及各自测试；精确新增字段在实施前写入 architecture §10.3/§6.3。

**Interfaces:** 只传受支持 tokenizer 标识，当前 UTC、测试注入时钟；显式保存/回执、独立召回授权、来源数据注入；无模型/无 tokenizer 时按可用能力降级。

- [x] 只读核实 owning API、现有设置和调用链，不输出凭证；固定可验证的最小 tokenizer 组合。
- [x] 契约与兼容/错误语义先文档提交（`9307d46`）；写失败回归后实施。
- [x] 用隔离真实 shim 身份验证保存/来源召回、无历史对照、关闭/失联/计数失败不影响聊天和提醒。
- [x] 独立评审，修复取消/恢复的未知状态与新窗口提示，复核通过；分意图提交见本轮审计。

### Task 3: 门禁与最终人工清单

- [x] 全仓 build/test/typecheck；相关 Python/Rust 和 Windows no-bundle 构建；三色结构完整性自动检查。
- [x] 更新单份审计与 roadmap，区分自动/实机/跨平台；完成只读全变更评审和 diff/用户文件哈希检查。
- [x] 提交本地 main，最终列实际结果及人工清单；不晋升素材或发布。
