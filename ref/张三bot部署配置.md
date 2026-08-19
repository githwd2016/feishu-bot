---
title: "张三bot部署配置"
source: "https://www.doubao.com/thread/xpnh8Mp9gBteVeARo"
author:
published:
created: 2026-08-19
description: "豆包 是你的 AI 聊天智能对话问答助手，写作文案翻译情感陪伴编程全能工具。豆包 为你答疑解惑，提供灵感，辅助创作，也可以和你畅聊任何你感兴趣的话题。"
tags:
  - "clippings"
---
搜索 2 个关键词，参考 12 篇资料

## 完整部署：机器人名称「张三 bot」，@机器人触发 OpenCode review

> 使用方式：群聊 `@张三bot  https://gitcode.com/xxx/xxx/pull/123` 架构要点：
>
> 1. 只 @机器人触发， **不需要高危全群消息权限** ；
> 2. 本地常驻： `feishu‑bridge.js` （pm2 托管，登录自启）；
> 3. **不启动 opencode serve** ；收到消息动态执行 `opencode run "/review PR_URL"` ，执行完进程销毁。

## 0 本地前置校验（必须先完成）

```bash
# 确认OpenCode命令可用
opencode --version
# 确认/review skill已加载
opencode skills list
# 本地手工验证评审链路，替换成真实PR链接
opencode run "/review https://gitcode.com/xxx/xxx/pull/123"
```

> ✅本地终端能正常输出 review 结果，再往下配置飞书。

## 1 飞书开放平台修改机器人基础信息

1. 浏览器打开 [https://open.feishu.cn](https://link.wtturl.cn/?target=https%3A%2F%2Fopen.feishu.cn&scene=im&aid=497858&lang=zh "autolink") ，进入你的企业自建应用
2. 左侧菜单： **机器人与应用**
3. 修改配置：

- 机器人名称： `张三bot`
- 机器人描述： `@我 + GitCode PR链接，触发本地OpenCode代码评审`
- 机器人头像：可上传头像，也可以使用默认图标

4. 页面底部点击 **保存** 飞书。

> ⚠️保存不等于生效， **必须创建新版本发布，群内才会显示「张三 bot」** 。

### 确认权限（不要新增全群消息权限）

左侧【权限管理】，保留下面 4 个权限：

```
im:message.group_at_msg
im:message.group_at_msg:readonly
im:message.p2p_msg
im:message:send_as_bot
```

> 逻辑： **只有 @张三 bot，才推送消息事件给本地桥接** 。

## 2 创建新版本发布（改名必做）

1. 左侧菜单： **版本管理与发布**
2. 点击【创建版本】
	- 版本号： `1.0.1` （版本号高于上一次）
	- 更新说明： `机器人名称改为张三bot，代码评审机器人`
3. 保存版本，提交发布，企业自建应用等待管理员审批通过。
4. 将机器人重新加入目标测试群聊。

> ✔️现在群内 @弹窗列表出现： `张三bot` ， **必须选择这个条目才会触发 review** 。

## 3 本地桥接脚本（直接复用）

进入项目目录

```bash
cd ~/work/feishu-oc-bridge
```

### feishu‑bridge.js 完整代码

```javascript
require('dotenv').config();
const { Feishu } = require('@larksuiteoapi/node-sdk');
const { execFile } = require('child_process');

const client = new Feishu({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
});

const REVIEW_TIMEOUT = 120 * 1000;

async function sendChatMessage(chatId, text) {
  try {
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  } catch (e) {
    console.error("发送飞书消息失败", e);
  }
}

client.event.on('im.message.receive_v1', async (evt) => {
  const { message } = evt;
  let content;
  try {
    content = JSON.parse(message.content).text;
  } catch (err) {
    return;
  }

  // 匹配GitCode PR链接
  const prMatch = content.match(/https:\/\/gitcode\.com\/[^\s]+\/pull\/\d+/);
  if (!prMatch) {
    console.log("未识别GitCode PR链接");
    return;
  }

  const prUrl = prMatch[0];
  const chatId = message.chat_id;

  await sendChatMessage(chatId, \`✅张三bot收到，正在评审 PR：${prUrl}\`);

  execFile(
    'opencode',
    ['run', \`/review ${prUrl}\`],
    { timeout: REVIEW_TIMEOUT, shell: false },
    async (err, stdout, stderr) => {
      let output = "";
      if (err) output += \`## 执行异常\n${err.message}\n\n\`;
      if (stderr) output += \`stderr:\n${stderr}\n\n\`;
      if (stdout) output += \`## Review结果\n${stdout}\`;
      if (!output) output = "未返回输出，请检查本地 /review skill";
      await sendChatMessage(chatId, output);
    }
  );
});

console.log("✅飞书桥接已启动｜@张三bot + PR链接触发review，无需opencode serve");
client.event.start();
```

### .env 配置不变

```
FEISHU_APP_ID=cli_你的AppID
FEISHU_APP_SECRET=你的AppSecret
```

替换为飞书开放平台拿到的真实凭证。

## 4 前台调试运行（先测试）

```bash
node feishu-bridge.js
```

看到输出： `✅飞书桥接已启动｜@张三bot + PR链接触发review，无需opencode serve`

飞书群发送消息测试：

```
@张三bot https://gitcode.com/xxx/xxx/pull/123
```

测试通过后， `Ctrl+C` 停止前台进程。

## 5 pm2 后台托管（推荐，崩溃自动重启、登录自启）

```bash
# 全局安装pm2
npm install -g pm2

cd ~/work/feishu-oc-bridge
# 启动桥接进程
pm2 start feishu-bridge.js --name feishu-zhangsan-bot

# 查看状态日志
pm2 status
pm2 logs feishu-zhangsan-bot

# 设置macOS登录自动拉起桥接
pm2 startup
pm2 save
```

### pm2 常用运维命令

```bash
pm2 restart feishu-zhangsan-bot   # 重启桥接
pm2 stop feishu-zhangsan-bot      # 停止
pm2 delete feishu-zhangsan-bot    # 删除进程
```

## ✅日常上班操作

1. 如果 pm2 自启生效： **开机登录 mac，什么命令不用敲** ；
2. 如果自启失效，执行一行：

```bash
pm2 start feishu-zhangsan-bot
```

> ❗永远不要执行 `opencode serve` 。

## 使用示例（飞书群）

```
@张三bot https://gitcode.com/demo/test/pull/456
```

- 机器人回复： `✅张三bot收到，正在评审 PR：xxx`
- 本地自动拉起一次性 `opencode run` 进程，评审结束进程销毁；
- review 结果自动回写到群聊。

## 链路回顾

```
飞书群 @张三bot + GitCode PR链接
        ↓
【常驻】pm2托管 node feishu‑bridge.js（飞书长连接）
        ↓（收到消息动态调用）
opencode run "/review PR_URL"（临时进程，跑完退出）
        ↓
/review skill执行评审（skill内部调用GitCode OpenAPI获取PR diff）
        ↓
评审结果回写飞书群
```

## 排错要点

1. @张三 bot 无反应：确认机器人已经加入群；权限已申请并且版本发布；查看 `pm2 logs feishu‑zhangsan‑bot` 日志；
2. 收到消息无 review 输出：回到步骤 0 手工执行 `opencode run "/review PR"` ，确认 skill 本身正常；
3. mac 休眠断网：pm2 会自动重启桥接重建长连接。

> 备注：skill 本身需要自行调用 GitCode OpenAPI 拉取 PR diff，OpenCode 原生不支持 GitCode。如果你需要，我可以提供 `/review` skill 的 yaml 模板。
