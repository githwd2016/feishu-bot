# 飞书 × GitCode 自动 Review Bot

机器人既支持在飞书群内通过 `@机器人 + GitCode PR 链接` 手动发起审查，也会定时扫描当前 `GITCODE_TOKEN` 账号的 PR 待办：

自动扫描会跳过标记为 Draft/WIP 的 PR；手动发起审查不受此限制。

- `need_my_approve`：当前账号是审查人时自动运行代码审查；有待处理意见时在飞书 @ PR 作者，无待解决问题时 @ 当前审查人；
- `created_by_me`：当前账号创建的 PR，自动 @ GitCode 中已分配审查人的对应机器人；
- 审查意见产生后，PR 作者的机器人会自动修改、测试、提交、回复并请求原审查人复审；
- 全部意见解决后只通知可以合入，不自动执行评审通过或合并。

支持 Codex + GitCode 插件和 OpenCode 两种 agent 后端。

## 运行要求

- Node.js 20+
- GitCode Personal Access Token
- Codex CLI（并启用 GitCode 插件）或 OpenCode CLI
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

IDENTITY_MAPPINGS_JSON=[{"displayName":"张三","feishuOpenId":"ou_zhangsan_user","gitcodeLogin":"zhangsan","botOpenId":"ou_zhangsan_bot"},{"displayName":"李四","feishuOpenId":"ou_lisi_user","gitcodeLogin":"lisi","botOpenId":"ou_lisi_bot"}]

AUTO_REVIEW_CHAT_ID=oc_target_group
PR_SCAN_INTERVAL_SECONDS=300
AGENT_TIMEOUT_MS=1800000
MAX_REVIEW_CYCLES=3
STATE_FILE=./data/state.json
```

### 三方身份映射

`IDENTITY_MAPPINGS_JSON` 是唯一的用户和机器人身份配置，直接替代旧版的 `OWNER_OPEN_ID`、`OWNER_NAME` 和 `REVIEWERS_JSON`：

- `displayName`：飞书提示中使用的名称，可省略，默认使用 GitCode login；
- `feishuOpenId`：用于 @ 这个人的飞书用户 open_id；
- `gitcodeLogin`：用于匹配 PR 作者和审查人，大小写不敏感；
- `botOpenId`：用于 @ 这个人对应的飞书审查机器人。

三类 ID 必须各自唯一。服务启动时会同时读取飞书 bot 身份和 GitCode `/user`，二者必须命中同一条映射，否则服务会拒绝启动，避免使用错误账号审查。

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

## 状态、去重与恢复

状态默认保存在 `data/state.json`：

- 飞书消息按 `message_id` 去重；
- 所有外部审查请求按 `PR + 发起方 + mode + cycle + head SHA` 持久化去重；
- 自动任务保存 head SHA、目标审查人、尝试次数和终态；
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

- 所有 PR 必须属于 `GITCODE_ALLOWED_REPOS`；
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
schemas/                agent 结构化结果定义
test/                   单元与流程测试
```
