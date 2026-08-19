你正在使用 Codex 和已安装的 GitCode 插件，自动处理自己 PR 上的审查意见。

目标 PR：{{PR_URL}}

{{WORKTREE_NOTICE}}

这是 PR 所有人明确授权的自动修改任务。你已获授权仅对上面的精确 PR 读取评论，修改其源分支代码，运行测试，commit、正常 push，并在对应 discussion 下回复修改结果。不得操作其他 PR 或 force push。

工作要求：

1. 必须加载并遵守 `gitcode:gitcode-address-feedback` 技能；使用 GitCode 插件获取 PR 元数据、changed files、commits 和 comments。
2. 先确认当前临时 worktree 的 origin 与目标仓库一致，从 PR 元数据确定源分支和最新 head SHA。当前 worktree 初始为 detached HEAD：执行 `git fetch origin <源分支>`，再用 `git checkout --detach FETCH_HEAD` 对齐 PR 最新源分支。只检查当前 worktree 的状态；不得检查或使用主工作区中的 `.codex/`、`.workbuddy/` 等未跟踪内容作为 blocker。
3. 按 discussion 聚类未解决反馈，区分明确可执行意见、重复/过期意见和冲突/模糊意见。处理所有明确可执行意见；模糊或冲突意见保留未解决并记录 blocker。
4. 修改代码并运行与改动相称的测试。不得通过删除测试、放宽断言、吞异常等方式伪造通过。
5. 在 detached HEAD 上 commit，然后使用 `git push origin HEAD:<精确的 PR 源分支>` 正常推送，禁止 force push。推送前再次核对远端分支名称和当前 commit 的父提交来自 PR head。
6. 对每一条已处理意见，在对应 discussion 下回复修改内容、测试结果和 commit SHA。插件 0.1.0 尚未暴露 discussion reply，因此只允许使用这个窄 fallback：
   `node "$REVIEW_BOT_HELPER" reply "{{PR_URL}}" --discussion-id <id> --body-file <file> --confirm-target <owner/repo#number>`
   回复正文必须先落到临时文件。不得使用 fallback 创建 top-level 或 inline comment。
7. 不要自行把审查者的 discussion 标记为 resolved；由复审机器人验证后解决。
8. 最后重新使用插件读取 comments。若插件内容不足以确认状态，可对目标 PR 使用 helper 的只读 `comments` 命令核验。
9. 任何关键修改、测试、push 或回复失败都返回 blocked。不得输出、记录或把 GITCODE_TOKEN 放进命令行。
10. 最终严格按照 output schema 返回 JSON，不要添加 Markdown 代码围栏。`action` 为 `address_feedback`；`unresolvedCount` 是等待复审的 discussion 数量。
