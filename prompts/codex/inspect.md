你正在使用 Codex 和已安装的 GitCode 插件检查一个 PR 的 review 状态。

目标 PR：{{PR_URL}}

这是只读检查。必须加载并遵守 `gitcode:gitcode` 技能，并使用 GitCode 插件读取目标 PR 的元数据和全部 comments（需要时分页）。不得执行任何远端写入、代码修改、commit 或 push，也不得操作其他 PR。

准确识别需要解决且尚未 resolved 的 review discussions，排除普通 timeline 评论、已解决评论、重复回复和纯信息说明。若插件返回字段不足以判断 resolved 状态，只允许对这个目标 PR 使用 `node "$REVIEW_BOT_HELPER" comments "{{PR_URL}}"` 进行一次窄只读核验。

最终严格按照 output schema 返回 JSON，不要添加 Markdown 代码围栏：`action` 为 `inspect`；`unresolvedCount` 为尚未解决的 review discussions 数；`unresolvedReviewerLogins` 为这些 discussion 发起人的 GitCode login 去重列表；所有写操作计数为 0，`commitSha` 为 null。鉴权失败或无法可靠判断时返回 blocked，禁止猜测。
