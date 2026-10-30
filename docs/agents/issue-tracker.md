# Issue tracker: GitHub

仓库：destinyTaoTao/maneki-pet。
需求、Bug 与规格票据记录在该仓库的 GitHub Issues。
架构规范仍以 docs/architecture.md 为唯一事实来源。

优先使用已连接且能力足够的 GitHub 工具；
否则使用 gh CLI，并显式指定
--repo destinyTaoTao/maneki-pet。

## 常用操作

- 创建：`gh issue create --title "..." --body-file <file>`
- 读取：`gh issue view <number> --json number,title,body,labels,comments`
- 列表：`gh issue list --state open --json number,title,body,labels`
- 评论：`gh issue comment <number> --body-file <file>`
- 标签：`gh issue edit <number> --add-label "..."` 或 `--remove-label "..."`
- 关闭：`gh issue close <number>`

上述命令均附加显式 --repo 参数。
多行正文使用 UTF-8 文件和 --body-file，不拼接进 shell 命令。
完整检索时处理分页，不把默认列表数量当成全部结果。
标签映射见 triage-labels.md。

## 技能用语

“publish to the issue tracker”表示创建 GitHub Issue。
“fetch the relevant ticket”表示读取 Issue 正文、评论和标签。

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub Issue 与 PR 共用编号；裸编号存在歧义时先解析类型。

## Wayfinding operations

- Map 是标记 wayfinder:map 的总览 Issue。
- 子票据优先使用原生 sub-issue；不可用时以总览任务列表
  和子票据中的 Part of #<map> 相互关联。
- 子票据类型使用 wayfinder:research、wayfinder:prototype、
  wayfinder:grilling、wayfinder:task。
- 阻塞关系优先使用原生 issue dependencies；不可用时在正文
  记录 Blocked by: #<number>。
- Frontier 仅包含无未关闭阻塞项且未分配的开放子票据，
  按总览顺序选择。
- 认领时分配给执行者；完成后记录结论、关闭票据，
  并更新总览中的决策与链接。
