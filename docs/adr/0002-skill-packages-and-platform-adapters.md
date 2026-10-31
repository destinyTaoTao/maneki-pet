# 技能包归外壳、平台对接走"AI 备料 + 人工发布 + 证据回流"、EverNook 集成为 Python shim

状态：已接受（2026-10-31，与 EverNook 记忆仓库共同定稿的设计共识；对应 EverNook ADR-0006 与 spec"技能沉淀与执行增量"）。

## 背景

Maneki 要扩展两个功能域：平台运营（B站/抖音/QQ）与技能包体系（沉淀 Pet 的做事方法为可复用能力）。EverNook 侧已确认：知识进记忆（有来源的 `skill_draft` 经验）、能力进外壳（技能包）、凭证进保险库；记忆模块永不存储/执行技能包，也不把经验自动升级为执行规则（EverNook ADR-0006）。

## 决策

1. **技能包体系归 Maneki 外壳扩展**：包格式（SKILL.md + scripts/ + 纯数据清单 + 内容哈希）、生命周期（显式安装 → 启用/停用 → 注入清单登记）、物化（从已启用 skill_draft 经验经用户显式触发生成骨架，experience_id 回链，正文人工定稿）全部在 Maneki 实现；执行仍按 M6 隔离验收门槛，本期不开放。
2. **平台对接只有两条合规路径**：官方开放平台 API（需主体资质，当前 B站个人不可入驻、抖音代投稿已被官方收回）与"AI 备料 + 人工发布 + 证据回流"。明令禁止 biliup 类 cookie 投稿、协议模拟、QQ OneBot/NapCat 账号接管、客户端 UI 自动化；对外互动只做汇总+建议草稿；写操作逐次确认；无全自动档。
3. **EverNook 集成形态为 Python shim**：`packages/adapters/evernook` 实现 EverNook 官方 `AdapterSurface`（pair 用 HARNESS_DEFAULT_SCOPES、capture 整轮缓冲原文保真、inject 走 ContextBuilder+显式注入清单、gaps 结构化披露），以官方 `ConformanceSuite` 全套件通过为验收；Maneki TS 经 JSON CLI 子进程调用，EverNook 仓库零改动。

## 代价

- 技能包与经验的来源关系只能靠调用端记录 `experience_id` 回链，EverNook 账本无一等引用字段（EverNook 侧待首个真实技能域验证后再评估升级）。
- 平台功能上限受合规红线约束：无一键代发、无数据抓取，运营数据依赖人工导出；换取账号安全与平台合规。
- 引入 Python 运行前提（EverNook venv，Python 3.14 Windows NTFS）：TS 运行时需经子进程调用 shim，多一层进程边界与版本管理成本。

## 不采用的替代

- 技能包存进 EverNook 账本并授予执行：违反"经验记忆不授予工具权限"不变量。
- 官方 API 直发（当前）：B站个人主体不可入驻，资质路径作为未来可选解锁。
- TS 直接实现 EverNook 协议：绕开官方 Python 核心（SQLite/ACL/凭证语义），重复实现且脱离 conformance 验收面。

实现规范见 [architecture.md](../architecture.md) §10；验收竖切六条见 EverNook spec"技能沉淀与执行增量"。
