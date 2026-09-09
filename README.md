# 飞书 × GitCode / GitHub 自动 Review Bot

同一个机器人实例可以同时处理 GitCode 和 GitHub 仓库：在飞书群中通过 `@机器人 + PR 链接` 发起审查，或定时扫描两个平台上当前账号的 PR 待办。原有 GitCode 配置默认保持兼容。

GitCode 扫描规则：

自动扫描会跳过标记为 Draft/WIP 的 PR；手动发起审查不受此限制。

- `need_my_approve`：当前账号是审查人时自动运行代码审查；有待处理意见时在飞书 @ PR 作者，无待解决问题时 @ 当前审查人；
- `created_by_me`：当前账号创建的 PR，自动 @ GitCode 中已分配审查人的对应机器人；
- 审查意见产生后，PR 作者的机器人会自动修改、测试、提交、回复并请求原审查人复审；
- 全部意见解决后只通知可以合入，不自动执行评审通过或合并。

支持 Codex 和 OpenCode 两种 agent 后端。GitCode 的 Codex 任务使用已安装插件；GitHub 任务在两种后端中都使用项目内的 GitHub helper。GitHub 根据个人 Reviewers 请求发现待审 PR，不能把 Assignees 当作审查人。

## 运行要求

- Node.js 20+
- 每个启用平台对应的个人 Personal Access Token
- Codex CLI（处理 GitCode 时启用 GitCode 插件）或 OpenCode CLI
- 需要自动修改的仓库本地 checkout
- 能长期运行 Node 服务的主机

```bash
npm install
cp .env.example .env
```

## 飞书应用配置

在[飞书开发者后台](https://open.feishu.cn/app?lang=zh-CN)创建企业自建应用并添加机器人能力，开通以下应用身份权限：

| 权限标识 | 用途 |
| --- | --- |
| `im:message.group_at_msg.include_bot:readonly` | 接收用户和其他机器人 @ 当前机器人的消息 |
| `im:message.p2p_msg:readonly` | 接收单聊配置命令和直接审查请求 |
| `im:message:send_as_bot` | 在群内发送消息并 @ 用户或机器人 |

在“事件与回调”中选择长连接并订阅 `im.message.receive_v1`，发布应用版本，然后把所有参与协作的机器人添加到同一个目标群。

## 配置

基础配置示例：

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
BOT_NAME=张三bot

GITCODE_TOKEN=xxx
GITCODE_ALLOWED_REPOS=example-org/example-repo
GITCODE_API_BASE=https://api.gitcode.com/api/v5
REPO_WORKDIRS_JSON={"example-org/example-repo":"/absolute/path/to/example-repo"}

IDENTITY_MAPPINGS_JSON=[{"displayName":"张三","feishuOpenId":"ou_zhangsan_user","gitcodeLogin":"zhangsan","commit_name":["张三","zhangsan"],"botOpenId":"ou_zhangsan_bot"},{"displayName":"李四","feishuOpenId":"ou_lisi_user","gitcodeLogin":"lisi","commit_name":["李四"],"botOpenId":"ou_lisi_bot"}]

AUTO_REVIEW_CHAT_ID=oc_target_group
PR_SCAN_INTERVAL_SECONDS=300
AGENT_TIMEOUT_MS=1800000
MAX_REVIEW_CYCLES=3
STATE_FILE=./data/state.json
```

### 同一实例启用 GitCode 和 GitHub

在现有配置上增加以下设置，无需启动第二个飞书机器人进程：

```dotenv
REPO_PROVIDERS=gitcode,github
GITHUB_TOKEN=xxx
GITHUB_ALLOWED_REPOS=example-org/example-repo
GITHUB_API_BASE=https://api.github.com
REPO_WORKDIRS_JSON={"example-org/example-repo":"/absolute/path/to/gitcode-repo","github:example-org/example-repo":"/absolute/path/to/github-repo"}
IDENTITY_MAPPINGS_JSON='[
  {"displayName":"张三","feishuOpenId":"ou_zhangsan_user","gitcodeLogin":"zhangsan","githubLogin":"zhangsan-gh","commit_name":["张三"],"botOpenId":"ou_zhangsan_bot"},
  {"displayName":"李四","feishuOpenId":"ou_lisi_user","gitcodeLogin":"lisi","githubLogin":"lisi-gh","commit_name":["李四"],"botOpenId":"ou_lisi_bot"}
]'
```

`REPO_PROVIDERS` 默认为 `gitcode`；也可设为 `github`，此时不需要 GitCode token、白名单或 login。双平台模式下，两套 token 分别通过各自 `/user` 验证，必须都属于当前 bot 对应的人。其他参与者可以只填写其使用平台的 login；审查人缺少该平台映射时不会进行部分分发。

白名单按平台独立配置。双平台模式中，`REPO_WORKDIRS_JSON` 的旧键 `owner/repo` 仍属于 GitCode；GitHub 使用 `github:owner/repo`，GitCode 也可显式使用 `gitcode:owner/repo`。仅启用 GitHub 时允许使用无前缀键。两个平台存在同名仓库时应配置各自的 checkout。周报汇总所有已配置平台的本地仓库，相同目录路径只统计一次。

GitHub 配置面向 **github.com**，暂不支持 GitHub Enterprise Server 自定义网页域名。token 需能读取目标仓库、PR 和审查讨论；发布/回复/解决讨论需要 Pull requests 写权限。自动修复还需要独立可用的 Git fetch/push 凭据（SSH 或 credential helper）；不会将 API token 拼进 git 命令。具体权限参见 [GitHub review comments API](https://docs.github.com/en/rest/pulls/comments)。

GitHub 扫描按白名单仓库分页读取开放 PR：个人 `requested_reviewers` 中包含当前账号的 PR 会自动审查，本人创建的 PR 会分发给已请求或已提交过审查的个人 reviewer。Draft/WIP 自动跳过。团队 Reviewers 暂不自动展开；本人 PR 有团队审查请求时会提示改为个人 Reviewers。讨论是否解决由 [GitHub GraphQL review threads](https://docs.github.com/en/graphql/reference/pulls) 确定，过期讨论不会被当作已解决。完整读取失败会阻塞任务，不会把结果当作零条意见。

GitHub 审查、回复、自动修复和复审沿用现有飞书指令及机器人消息协议。任务状态保留旧 GitCode 键 `owner/repo#number`，GitHub 使用 `github:owner/repo#number`，避免同名 PR 冲突。两个平台独立扫描，其中一个平台扫描失败不会阻止另一个平台继续。会话中只有一个任务时仍可不带链接发送取消/确认命令；有多个任务时必须附上目标 PR 链接。

GitHub helper 提供 `pr`、`files`、`commits`、`comments`、`inline`、`reply`、`resolve`。写操作的 `--confirm-target` 必须包含平台前缀（例如 `github:owner/repo#42`），回复和解决讨论会再次校验 discussion 属于精确 PR。行内评论使用 `--line`、`--side LEFT|RIGHT` 和所审查的 `--commit-id`；head 已改变则拒绝发布。GitHub fork PR 的审查从 base 仓库 `refs/pull/<number>/head` 读取，修复仅推送到元数据指定的源仓库和源分支，无权限时返回 blocked。

### 三方身份映射

`IDENTITY_MAPPINGS_JSON` 是唯一的用户和机器人身份配置，直接替代旧版的 `OWNER_OPEN_ID`、`OWNER_NAME` 和 `REVIEWERS_JSON`：

- `displayName`：飞书提示中使用的名称，可省略，默认使用 GitCode login；
- `feishuOpenId`：用于 @ 这个人的飞书用户 open_id；
- `gitcodeLogin` / `githubLogin`：用于匹配对应平台的 PR 作者和审查人，大小写不敏感；
- `commit_name`：可选的 Git 提交作者名列表，命中其中任意一个名称即归属到该 `gitcodeLogin`，大小写不敏感；
- `botOpenId`：用于 @ 这个人对应的飞书审查机器人。

在 `.env` 中，`IDENTITY_MAPPINGS_JSON` 可以使用单引号包裹成跨行 JSON；不要直接写未加引号的多行 JSON，否则 dotenv 会在第一行截断变量值。`.env.example` 已提供可直接复制的写法。

飞书用户 ID、bot ID 和各平台的 login 必须分别唯一。服务启动时读取飞书 bot 身份和每个已启用平台的 `/user`，必须命中同一条映射，否则拒绝启动。

旧版 owner/reviewer 变量不再兼容，`local` reviewer 模式也已移除。

### 获取飞书 ID

每个机器人启动时会输出：

```text
[setup] BOT_OPEN_ID=ou_xxx BOT_NAME=张三bot
```

首次部署尚不知道 bot open_id 时，可以先在映射中填写一个临时唯一值并启动一次；服务会在身份校验失败前输出真实 `BOT_OPEN_ID` 和 `GITCODE_LOGIN`。更新映射中的 bot ID 后再次启动。`feishuOpenId` 尚未知时也可先填写临时唯一值，待机器人成功启动后通过下面的命令取得真实值并再次更新配置。

用户可向机器人发送：

```text
获取我的 open_id
```

机器人会返回发送者的 `feishuOpenId`。在目标群发送：

```text
@张三bot 获取 chat_id
```

机器人会返回当前群的 chat ID。首次部署可暂时留空 `AUTO_REVIEW_CHAT_ID`；手动消息仍可使用，但定时扫描会保持禁用。填入 chat ID 并重启后，服务会立即扫描一次，此后按 `PR_SCAN_INTERVAL_SECONDS` 扫描，最小值为 60 秒，默认 300 秒。

### Agent 后端

Codex：

```dotenv
AGENT_BACKEND=codex
CODEX_BIN=codex
CODEX_MODEL=
CODEX_PROFILE=
CODEX_BYPASS_APPROVALS_AND_SANDBOX=true
```

OpenCode：

```dotenv
AGENT_BACKEND=opencode
OPENCODE_BIN=opencode
OPENCODE_MODEL=provider/model
OPENCODE_AGENT=
OPENCODE_VARIANT=high
OPENCODE_AUTO_APPROVE=true
```

放宽审批或沙箱限制只应在专用、外部已隔离的运行环境中使用。

## 启动

```bash
npm run check
npm test
npm start
```

后台运行可使用 PM2：

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs feishu-bot
```

## 工作流程

### 自动扫描分配给当前账号的 PR

```text
GitCode need_my_approve
  -> 当前 bot 运行 initial review
  -> 在 GitCode 写 inline comments
  -> 有待处理意见时在固定飞书群 @ PR 作者本人
  -> 无待解决问题时在固定飞书群 @ 当前审查人本人
  -> 若 PR 作者未配置飞书映射，则开始、进度、结果和失败通知改为私聊当前审查人，不发到群里
```

相同 `PR + head SHA + 当前账号` 只执行一次；PR 推送新提交后允许重新审查。失败会在后续扫描重试，连续三次失败后停止该版本重试；通知按上述作者映射规则路由。

### 自动扫描当前账号创建的 PR

```text
GitCode created_by_me
  -> 读取 PR assignees
  -> 当前 bot 在固定群 @ 每个审查人的 bot
  -> 审查 bot 创建 inline comments 并回报结果
  -> 作者 bot 修改、测试、push、回复 comments
  -> 请求原评论作者复审
  -> comments 全部 resolved 后 @ 作者本人
```

审查人按 `PR + head SHA + GitCode login` 分别去重。新增审查人只通知新增目标；新提交会重新通知全部当前审查人。没有审查人或任一审查人缺少三方映射时不会执行部分分发，而是在群中 @ PR 作者说明原因。

### 手动使用

本人在群里 @ 自己的机器人并附上本人 PR 时，机器人实时读取 GitCode `assignees` 后执行同一分发流程：

```text
@张三bot 请审查 https://gitcode.com/example-org/example-repo/pull/123
```

其他用户或机器人发送 PR 链接时，当前机器人直接审查该 PR。机器人互审必须在包含全部机器人的群聊中进行；单聊仍可用于配置命令和让当前机器人直接审查别人的 PR。

如果部分审查机器人没有返回结果，PR 所有人可以在同一群聊中明确确认本轮审查完成，跳过仍在等待的 reviewer，直接按 GitCode 当前 comments 进入修改流程：

```text
确认审查完成 https://gitcode.com/example-org/example-repo/pull/123
```

也支持“人工决定本轮复审结束”等同义说法。普通消息不会触发修改；人工确认只对正在等待 reviewer 结果的审查任务生效。

### 取消任务

审查或按 review comments 修改代码期间，可在同一会话发送以下任一命令取消当前任务，也可以在命令后附上 PR 链接指定任务：

```text
取消审查
取消修复 https://gitcode.com/example-org/example-repo/pull/123
停止任务
```

取消会立即终止当前本地 agent 进程，并将任务标记为 `cancelled`；之后到达的 reviewer 回报不会继续推进该 PR。已取消的任务不会被重复请求自动恢复，用户可以再次发送普通审查请求重新开始。

### 生成本周提交周报

在飞书群或与机器人单聊中发送以下命令，机器人会按中国时区统计本周一 00:00 至当前时间的 Git 提交，并返回周报：

```text
总结本周提交
生成周报
```

周报只读取 `REPO_WORKDIRS_JSON` 中配置的本地仓库，不会扫描其他目录或 GitCode 仓库。机器人会先按 `commit_name`（以及 login/displayName）确定提交归属，再调用当前配置的 Codex/OpenCode 后端，按 `IDENTITY_MAPPINGS_JSON` 中的每个 `gitcodeLogin` 分组、按提交主题归类，每个主题输出一句简短的中文总结；没有提交的人员也会保留小节。未配置仓库、作者无法可靠匹配或某个仓库读取失败时，周报会明确显示对应状态。

## 状态、去重与恢复

状态默认保存在 `data/state.json`：

- 飞书消息按 `message_id` 去重；
- 所有外部审查请求按 `PR + 发起方 + mode + cycle + head SHA` 持久化去重；
- 自动任务保存 head SHA、目标审查人、尝试次数和终态；
- 本人 PR 的飞书分发与 GitCode 自动扫描共用 PR 状态：进行中、已取消或达到最大复审轮次时不会自动重新分发；达到上限后即使 head SHA 改变也需人工重新发送审查请求。已完成的同一 head SHA 不重复分发，新提交仍可自动触发；
- 自动审查的开始、心跳和完成消息会显示短 commit SHA 与当前尝试次数；每次失败都会明确说明本次已结束，以及是否会在下次扫描重试；
- 同一 PR 的事件串行处理；所有本地 agent 任务全局串行，防止扫描一次启动过多进程；
- 服务重启后，已成功的相同指纹不会重复执行，过期的运行中任务允许重试；
- 修改代码期间重启会把该 PR 标记为失败并通知人工重新发起。
- 用户主动取消的 PR 会标记为 `cancelled`，不会继续接收 reviewer 状态消息；重新发送审查请求即可开启新任务。

同一 head SHA 的重复 initial 请求只执行一次；无显式 cycle 的请求在显式复审或新的 head SHA 时会开启新一轮并递增 cycle，协议请求则使用其提供的 cycle。重复请求在原任务运行时会收到“已在处理中”，原任务结束后则重放其结果。

机器人协议示例：

```text
[review-bot action=request mode=initial cycle=0]
[review-bot action=result mode=rereview cycle=1 status=success]
```

## GitCode 角色范围

- 合并人：负责最终执行合并；
- 审查人：负责 Code Review、发现问题并给出意见，本项目扫描 `need_my_approve` 和 PR `assignees`；
- 测试人：负责执行测试并标记测试状态；
- 评审人：负责最终审批是否允许合并。

本项目本次只自动化“审查人”职责，不自动处理测试、评审通过或合并。

## 安全边界与排障

- 所有 PR 必须属于对应平台的 `GITCODE_ALLOWED_REPOS` 或 `GITHUB_ALLOWED_REPOS`；
- `REPO_WORKDIRS_JSON` 必须使用仓库根目录的绝对路径，只用于创建临时 detached worktree；
- helper 写操作会再次校验精确的仓库和 PR；
- 服务不会 force push，也不会自动合并；
- PAT、`.env` 和状态文件不得提交到 Git。

常见检查：

1. 飞书应用已发布并订阅 `im.message.receive_v1`；
2. 所有机器人已加入 `AUTO_REVIEW_CHAT_ID` 对应群；
3. `IDENTITY_MAPPINGS_JSON` 中用户、GitCode login 和 bot open_id 无误；
4. `GITCODE_TOKEN` 属于当前 bot 映射的 GitCode 用户；
5. GitCode 仓库位于白名单，本地仓库和 push 凭据可用；
6. Codex 部署已启用 GitCode 插件，或 OpenCode helper 鉴权正常。

## 项目结构

```text
src/                    飞书、扫描器、状态机和 agent runner
prompts/codex/          Codex 任务提示
prompts/opencode/       OpenCode 任务提示
scripts/gitcode-api.js  GitCode 白名单 helper
scripts/github-api.js   GitHub 白名单 helper
prompts/github/        两种 agent 共用的 GitHub 任务提示
schemas/                agent 结构化结果定义
test/                   单元与流程测试
```
