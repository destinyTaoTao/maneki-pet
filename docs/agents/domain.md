# Domain Docs

## Layout

采用 single-context：

- 根目录 CONTEXT.md：领域术语。
- docs/adr/：重大决策及取舍原因。

未来新增 workspace 包不自动意味着拆分领域上下文。

## Before exploring

- 阅读根目录 AGENTS.md。
- 阅读 CONTEXT.md，使用其中定义的领域词汇。
- 阅读与当前任务有关的 docs/adr/。
- 按 AGENTS.md 阅读当前 roadmap 与相关 architecture 章节。

CONTEXT.md 或相关 ADR 不存在时静默继续，
不预先创建空文档；由 domain-modeling 在术语或决策明确后记录。

## Consumer rules

- Issue、规格、设计、测试命名使用既有领域词汇，
  不使用 glossary 明确排除的混称。
- 缺少必要词义时交由 domain-modeling 澄清。
- 与既有 ADR 冲突时明确指出，不静默覆盖。
- CONTEXT.md 只记录词义，ADR 记录取舍原因；
  docs/architecture.md 仍是架构与契约的唯一规范来源。
