# 飞书 × GitCode 自动 Review Bot

在飞书群里 `@机器人 + GitCode PR 链接`，机器人会通过飞书原生 @ 分发其他审查机器人，自动完成代码审查、提交 inline comments、按建议修改代码、回复评论、发起复审，并在所有意见解决后通知 PR 所有人合入。

支持两种执行后端：

- Codex + GitCode 插件
- OpenCode

## 快速部署

### 1. 准备运行环境

通用要求：

- Node.js 20+
- Git
- GitCode Personal Access Token
- PR 对应仓库的本地 checkout，用于自动修改代码
- 一台能够长期运行 Node 服务的机器

根据你的选择，再准备一个 agent：

- Codex：安装 Codex CLI，并启用 GitCode 插件；
- OpenCode：安装 OpenCode CLI，并配置可用模型。

先确认命令可用：

```bash
node --version
git --version

# 使用 Codex 时
codex --version
codex plugin list

# 使用 OpenCode 时
opencode --version
```

### 2. 安装项目

```bash
cd /path/to/feishu-bot
npm install
cp .env.example .env
```

所有密钥和部署参数都填写在 `.env` 中。不要把 `.env` 提交到 Git。

### 3. 创建飞书应用机器人

先打开以下两个页面：

- [飞书开发者后台](https://open.feishu.cn/app?lang=zh-CN)：实际创建和配置应用；
- [飞书官方图文配置说明](https://open.feishu.cn/document/develop-an-echo-bot/faq)：后台菜单与本文不一致时，对照官方截图。

#### 3.1 创建企业自建应用

1. 使用应用所属企业的飞书账号登录开发者后台。
2. 点击 **创建企业自建应用**。
3. 填写应用名称、描述和图标，例如名称填写“GitCode Review Bot”。
4. 点击 **创建**，进入应用详情页。

如果首页没有“创建企业自建应用”按钮，通常是当前账号没有开发者权限，需要联系企业管理员开通。

#### 3.2 添加机器人能力

1. 在应用详情页左侧进入 **应用能力 > 添加应用能力**。
2. 找到 **机器人**，点击 **添加**。
3. 确认左侧菜单中出现机器人相关配置项。

#### 3.3 申请消息权限

1. 进入 **开发配置 > 权限管理**。
2. 点击 **开通权限**，逐个搜索并开通下面三个**应用身份权限**：

   | 权限名称 | 权限标识 | 用途 |
   | --- | --- | --- |
   | 获取群组中其他机器人和用户 @ 当前机器人的消息 | `im:message.group_at_msg.include_bot:readonly` | 接收用户发起的 review，以及其他 review bot 发来的任务和完成通知 |
   | 读取用户发给机器人的单聊消息 | `im:message.p2p_msg:readonly` | 支持私聊触发任务 |
   | 以应用的身份发消息 | `im:message:send_as_bot` | 在群内回复状态和 @ 用户 |

#### 3.4 获取 App ID 和 App Secret

1. 进入 **基础信息 > 凭证与基础信息**。
2. 复制 **App ID** 和 **App Secret**，分别填写到 `.env` 的 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`。

### 4. 填写基础配置

打开 `.env`，先填写所有后端共用的配置：

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
BOT_NAME=张三bot

GITCODE_TOKEN=xxx
GITCODE_ALLOWED_REPOS=example-org/example-repo
GITCODE_API_BASE=https://api.gitcode.com/api/v5

REPO_WORKDIRS_JSON={"example-org/example-repo":"/absolute/path/to/example-repo"}

AGENT_TIMEOUT_MS=1800000
MAX_REVIEW_CYCLES=3
STATE_FILE=./data/state.json
```

配置说明：

- `GITCODE_ALLOWED_REPOS`：允许机器人操作的仓库白名单，多个仓库用逗号分隔；
- `REPO_WORKDIRS_JSON`：仓库与本地 Git 仓库根目录的映射；需要自动修改自己 PR 的机器人必须配置。该目录只用于创建临时 worktree，agent 不会直接在其中运行；
- `AGENT_TIMEOUT_MS`：单次审查、修改或复审任务的最长运行时间，默认 30 分钟；
- `MAX_REVIEW_CYCLES`：最多自动修改和复审多少轮，达到上限后转人工处理。

### 5. 选择 Codex 或 OpenCode

使用 Codex：

```dotenv
AGENT_BACKEND=codex
CODEX_BIN=codex
CODEX_MODEL=
CODEX_PROFILE=
CODEX_BYPASS_APPROVALS_AND_SANDBOX=true
```

`CODEX_MODEL` 留空时使用 Codex 当前默认模型。后台无人值守执行需要修改代码、push 和写 GitCode 评论，因此通常需要开启 `CODEX_BYPASS_APPROVALS_AND_SANDBOX`；只应在专用、外部已隔离的机器上开启。

使用 OpenCode：

```dotenv
AGENT_BACKEND=opencode
OPENCODE_BIN=opencode
OPENCODE_MODEL=provider/model
OPENCODE_AGENT=
OPENCODE_VARIANT=high
OPENCODE_AUTO_APPROVE=true
```

`OPENCODE_MODEL` 使用 `provider/model` 格式。无人值守执行通常需要开启 `OPENCODE_AUTO_APPROVE`，同样只应在专用、外部已隔离的机器上使用。

### 6. 配置审查机器人

单机首次联调，推荐先使用本地 reviewer：

```dotenv
REVIEWERS_JSON=[{"id":"local-reviewer","name":"本地审查角色","openId":"ou_display_only","gitcodeLogin":"zhangsan","mode":"local"}]
```

这样不需要部署第二个服务，review 和修改流程都在当前进程中完成。

正式的飞书多机器人配置示例：

```dotenv
REVIEWERS_JSON=[{"id":"lisi","name":"李四bot","openId":"ou_lisi_bot","gitcodeLogin":"lisi","mode":"feishu"}]
```

字段含义：

- `id`：当前部署内唯一的 reviewer 标识；
- `name`：飞书群里显示的机器人名称；
- `openId`：用于在群里 @ 对应机器人；启动目标机器人时，从其本机日志中的 `[setup] BOT_OPEN_ID=ou_...` 复制；
- `gitcodeLogin`：用于把 GitCode 评论重新分配给对应 reviewer；
- `mode`：`feishu` 表示通过群内真实 @ 触发对应机器人；`local` 表示在当前进程内运行逻辑 reviewer。

`feishu` 模式不需要 reviewer 的服务地址、共享密钥或公网入站端口。不同 reviewer 可以分别使用 Codex 或 OpenCode，只需在各自部署的 `.env` 中选择后端。

### 7. 验证配置并启动

先运行项目检查：

```bash
npm run check
npm test
```

验证 GitCode 鉴权和仓库白名单：

```bash
node --env-file=.env scripts/gitcode-api.js comments \
  https://gitcode.com/<owner>/<repo>/pull/<number>
```

前台启动：

```bash
npm start
```

启动时，服务会调用飞书官方“获取机器人信息”接口，并在本机日志输出当前机器人的身份：

```text
[setup] BOT_OPEN_ID=ou_xxxxxxxxxxxxxxxx BOT_NAME=李四bot
```

当前机器人不需要把这个值写进自己的独立环境变量。请把它提供给其他机器人维护者，用作对方 `REVIEWERS_JSON` 中指向当前机器人的 `openId`。每个参与互审的机器人都启动一次，即可收集全部 bot open_id。

保持进程运行，然后回到飞书开发者后台完成最后配置：

1. 进入 **开发配置 > 事件与回调 > 事件配置**。
2. 点击订阅方式旁的 **编辑**，选择 **使用长连接接收事件**，然后保存。
3. 在“已添加事件”区域点击 **添加事件**。
4. 搜索并添加 **接收消息**，确认事件标识为 `im.message.receive_v1`。
5. 进入 **应用发布 > 版本管理与发布**，点击 **创建版本**。
6. 填写版本号和更新说明，设置应用可用范围至少包含测试人员，然后提交发布；企业策略要求时需等待管理员审核。
7. **对外共享** 中允许机器人被添加到外部群中使用。
8. 在飞书客户端进入目标群的 **设置 > 群机器人 > 添加机器人**，搜索应用名称并添加。不要选择“自定义机器人”。

发布生效后，可以先让 PR 所有人与机器人单聊并发送测试消息（也可以在群里 @ 机器人）：

```text
获取我的 open_id
```

这是一条专用配置命令，无论 `.env` 中的 `OWNER_OPEN_ID` 当前为空、是旧占位值还是已经配置，都会重新输出本次发送者的 open_id。

机器人收到消息后，会在运行 `npm start` 的终端输出：

```text
[setup] OWNER_OPEN_ID=ou_xxxxxxxxxxxxxxxx
```

如果使用 PM2 运行，请通过下面的命令查找：

```bash
pm2 logs feishu-gitcode-review-bot --lines 100
```

飞书开发者后台的“事件日志检索”在长连接模式下只展示 EventID、返回状态和耗时等推送结果，不展示完整事件请求体，因此不需要在那里寻找 open_id。

现在把 PR 所有人信息补充到 `.env`：

```dotenv
OWNER_OPEN_ID=ou_xxxxxxxxxxxxxxxx
OWNER_NAME=张三
```

- `OWNER_OPEN_ID`：当前机器人所服务的 PR 所有人的飞书 open_id；该用户 @ 本机器人时，机器人会分发 reviewers 并负责后续自动修改；
- `OWNER_NAME`：机器人在群消息中 @ PR 所有人时使用的显示名称。

更新 `.env` 后重启服务。看到飞书长连接已启动，再按下文进行第一次 PR 测试。

## 群内使用方法

### 发起自己 PR 的审查

由 `.env` 中 `OWNER_OPEN_ID` 对应的人发送：

```text
@张三bot 请审查 https://gitcode.com/example-org/example-repo/pull/123
```

机器人会分发 reviewer。审查完成后：

- 没有待解决意见：通知 PR 所有人可以合入；
- 有待解决意见：自动修改、测试、commit、push，并逐条回复评论；
- 修改完成：自动请求原 reviewer 复审；
- 全部 comments 已解决：通知 PR 所有人合入。

执行过程中，机器人会在开始审查、同步 comments、自动修改和发起复审时报告当前阶段。单个 agent 任务超过 5 分钟仍未结束时，会继续发送运行时长提示；本机日志只显示会话 ID、当前阶段、运行时长和结果计数，不输出 agent 的完整对话、命令内容或长文本。

### 请当前机器人审查别人的 PR

其他人可以直接发送：

```text
@李四bot 请审查 https://gitcode.com/example-org/example-repo/pull/123
```

机器人会审查 PR，并把问题作为 GitCode inline comments 提交。

### 后续消息是否必须带 PR 链接

建议每次都附上 PR 链接。

只有当当前群恰好存在一个进行中的 PR 时，机器人才能自动关联不带链接的后续消息；存在多个 PR 时必须重新提供链接，避免改错仓库或分支。

### 可以在单聊中测试吗

可以在单聊中完成以下测试：

- 验证飞书长连接和消息接收；
- 获取并绑定 `OWNER_OPEN_ID`；
- 让当前机器人直接审查别人的 PR；
- 当所有 reviewer 都是 `mode: "local"` 时，测试完整流程。

如果 `REVIEWERS_JSON` 中存在 `mode: "feishu"`，PR 所有人发起“分发审查”时必须使用群聊，并确保当前机器人和全部 reviewer 机器人都已加入该群。机器人之间的 @ 事件不会通过用户与机器人的单聊会话转发。

## 后台运行

推荐使用 PM2：

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs feishu-gitcode-review-bot
```

常用命令：

```bash
pm2 status
pm2 restart feishu-gitcode-review-bot
pm2 stop feishu-gitcode-review-bot
pm2 logs feishu-gitcode-review-bot
```

机器人之间通过飞书事件通信，不需要为本服务配置 Nginx、Caddy 或公网入站端口。

## 常见问题

### 群里 @机器人没有响应

依次检查：

1. 飞书应用版本是否已经发布；
2. 机器人是否已经加入该群；
3. 是否订阅了 `im.message.receive_v1`；
4. 是否开通了 `im:message.group_at_msg.include_bot:readonly`；
5. `pm2 logs feishu-gitcode-review-bot` 是否有鉴权或长连接错误。

### 其他机器人 @ 当前机器人没有响应

依次检查：

1. 被 @ 的机器人是否开通 `im:message.group_at_msg.include_bot:readonly`；
2. 开通权限后是否创建并发布了新版本；
3. 两个机器人是否都已加入当前群；
4. 发送消息是否通过机器人 open_id 创建了真实 @，而不是普通文本 `@机器人名`；
5. `REVIEWERS_JSON` 中的 `openId` 是否与实际机器人一致。

### 提示仓库不在白名单

把 `<owner>/<repo>` 加入 `GITCODE_ALLOWED_REPOS`。大小写不敏感，不要填写完整 PR URL。

### 无法自动修改 PR

检查：

- `REPO_WORKDIRS_JSON` 是否包含该仓库；
- 路径是否为绝对路径并直接指向 Git 仓库根目录；
- 本地仓库的 `origin` 是否指向目标 GitCode 仓库；
- 本地仓库是否至少包含一个 commit，且 `git worktree list` 能正常执行；
- PAT 和 Git 凭证是否具有 push 权限。

### 主仓库中有未提交或未跟踪文件

不需要清理主仓库。每次审查、修改和复审都会从 `REPO_WORKDIRS_JSON` 对应仓库创建独立的临时 detached worktree，任务结束或失败后自动删除。日志中的 `[worktree] 已创建` 和 `[worktree] 已清理` 可用于确认生命周期。

`REPO_WORKDIRS_JSON` 必须指向仓库根目录，不能指向其中的子目录或另一个 worktree。临时 worktree 不会包含主工作区中的 `.codex/`、`.workbuddy/`、构建产物等未跟踪内容。

### Codex 找不到 GitCode 插件

运行：

```bash
codex plugin list
```

确认 `gitcode` 状态为 `installed, enabled`，并确保启动 Bot 的系统账户与配置 Codex 插件的账户相同。

### Codex 长时间没有最终结果

先查看飞书中的阶段消息，再运行：

```bash
pm2 logs feishu-gitcode-review-bot --lines 200
```

日志会显示当前任务、会话 ID、已运行时间、剩余超时时间和 Codex 简要进度。`AGENT_TIMEOUT_MS` 限制的是每一次审查、修改或复审，不是整个 PR 闭环的总时长。

如果服务在本地 agent 运行期间重启，启动后会把被中断的任务标记为失败并在飞书通知；重新发送同一个 PR 链接即可重试。

### 查看 agent 完整对话历史

每次任务开始后，本机日志会出现：

```text
[agent:codex:example-org/example-repo#123] 会话已保存 session=<会话ID>
```

复制会话 ID，然后在 `REPO_WORKDIRS_JSON` 对应仓库中打开历史会话：

```bash
# Codex
codex resume -C /absolute/path/to/repo <会话ID>

# OpenCode
opencode --session <会话ID> /absolute/path/to/repo
```

也可以让 Codex 显示包含后台任务在内的全部历史会话：

```bash
codex resume --all --include-non-interactive
```

任务使用的临时 worktree 会在结束后删除，但 agent 自己保存的会话历史不会随之删除。打开历史时应选择或指定 `REPO_WORKDIRS_JSON` 中的主仓库目录。

### OpenCode 没有返回最终 JSON

服务会先解析 `opencode run --format json` 的事件流；若事件流缺少最终文本，会自动读取该 session 的 export。仍失败时检查 OpenCode 模型、provider 鉴权和服务日志。

### 达到最大复审轮次

表示仍有未解决评论或 reviewer 之间存在冲突意见。机器人会停止自动循环并通知人工处理。处理完成后可以重新发起 PR 审查。

## 工作原理与限制

### 消息如何分流

- `OWNER_OPEN_ID` 对应的人 @本 bot：视为“我的 PR，请分发审查”；
- 其他人发送一个没有本地状态的 PR：当前 bot 直接进行 review；
- PR 已处于当前 bot 的跟踪状态：读取未解决评论，进入修改、复审或完成检查。

### 完整状态流

```text
PR 所有人 @自己的 bot + PR URL
  -> 分发 reviewer
  -> reviewer 在 GitCode 写 inline comments
  -> 无未解决评论：通知 PR 所有人合入
  -> 有未解决评论：修改、测试、commit、push、回复
  -> 请求原 reviewer 复审
  -> reviewer resolve 已修复评论，或继续提出问题
  -> 全部 resolved：通知 PR 所有人合入
```

状态保存在 `data/state.json`。飞书消息 ID 会持久化去重，服务重启后仍能继续识别进行中的 PR。

### 机器人之间如何通过飞书协作

每个机器人开通 `im:message.group_at_msg.include_bot:readonly` 后，应用机器人 A 发出的真实 @ 会通过 `im.message.receive_v1` 投递给机器人 B。本项目直接使用这条原生通道，不再部署机器人之间的 HTTP 回调：

```text
张三 @张三bot + PR URL
  -> 张三bot @李四bot [review request, cycle 0]
  -> 李四bot review，并在 GitCode 创建 inline comments
  -> 李四bot @张三bot [review result, cycle 0]
  -> 张三bot 等全部 reviewer 完成后读取 comments 并修改
  -> 张三bot @原 reviewer [rereview request, cycle 1]
  -> 原 reviewer @张三bot [rereview result, cycle 1]
  -> 全部 comments resolved 后，张三bot @张三通知合入
```

机器人消息中会包含类似下面的短标记，用于区分请求、结果和复审轮次：

```text
[review-bot action=request mode=initial cycle=0]
[review-bot action=result mode=rereview cycle=1 status=success]
```

服务会按飞书 `message_id` 去重，并忽略重复结果、非当前轮次结果以及未配置机器人的状态消息。reviewer 的“已收到”进度消息不会 @ 发起机器人，只有完成或失败时才回 @，避免提前推进状态机。

如果 reviewer 是第三方机器人，无法输出上述标记，也可以返回包含同一 PR 链接的明确结果，例如“审查意见已提交”“审查完成”或“审查失败”。兼容结果只接受 `REVIEWERS_JSON` 中当前等待的机器人 open_id；“已收到”“正在审查”等过程消息仍会忽略。第三方消息没有 cycle 信息，因此自有机器人仍推荐使用上面的严格标记协议。

### Codex 与 OpenCode 的差异

- Codex 优先使用已安装的 GitCode 插件读取 PR、diff、commits、comments，并创建 inline comments；当前插件缺失的 discussion reply 和 resolved 操作使用安全 helper 补齐。
- OpenCode 无法直接加载 Codex GitCode 插件，因此 GitCode 操作全部通过 [scripts/gitcode-api.js](./scripts/gitcode-api.js) 完成。
- 两种后端共享相同的飞书状态机和 [JSON 结果结构](./schemas/agent-result.schema.json)。

提示文件：

- [Codex prompts](./prompts/codex)
- [OpenCode prompts](./prompts/opencode)

### 安全边界

- 所有来自用户或其他机器人的消息入口都会检查仓库白名单；
- helper 的每个 GitCode 写操作必须再次确认精确的 `<owner>/<repo>#<PR号>`；
- 只有 `REVIEWERS_JSON` 中 open_id 匹配的机器人才能提交当前轮次结果；
- 结果消息必须匹配当前复审轮次，旧消息不会再次触发修改；
- `.env`、状态文件和依赖目录已加入 `.gitignore`；
- 每个 bot 建议使用独立系统账户、独立 checkout 和最小权限 PAT；
- 禁止 force push，禁止覆盖无关的本地改动；
- 服务只通知“可以合入”，不会自动点击合并。

`CODEX_BYPASS_APPROVALS_AND_SANDBOX` 和 `OPENCODE_AUTO_APPROVE` 都会放宽 agent 的执行限制，只能在专用、外部已隔离的环境中开启。

## 项目结构

```text
src/                    飞书、任务分发、状态机和 agent runner
prompts/codex/          Codex 任务提示
prompts/opencode/       OpenCode 任务提示
scripts/gitcode-api.js  GitCode 白名单 helper
schemas/                agent 结构化结果定义
test/                   单元与流程测试
ref/                    初始调研资料，不参与运行
```
