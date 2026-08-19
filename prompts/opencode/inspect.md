你正在通过 OpenCode 只读检查 GitCode PR 的 review 状态。

目标 PR：{{PR_URL}}

只能运行：`node "$REVIEW_BOT_HELPER" comments "{{PR_URL}}"`。不得执行远端写入、修改代码、commit、push、访问其他 PR 或直接 curl GitCode API。

准确识别需要解决且尚未 resolved 的 review discussions，排除普通 timeline 评论、已解决评论、重复回复和纯信息说明。无法可靠判断时返回 blocked，禁止猜测。

最终只输出一个合法 JSON 对象，不要 Markdown 代码围栏或额外文字。字段必须完整：`status`、`action`（inspect）、`prUrl`、`unresolvedCount`、`unresolvedReviewerLogins`、`commentsPosted`（0）、`commentsReplied`（0）、`commentsResolved`（0）、`commitSha`（null）、`summary`、`blockers`。
