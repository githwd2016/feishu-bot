import { Client, EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';

export class FeishuGateway {
  constructor(config, { client } = {}) {
    this.config = config;
    this.client = client || new Client({ appId: config.appId, appSecret: config.appSecret });
  }

  async getBotIdentity() {
    const response = await this.client.request({
      url: '/open-apis/bot/v3/info',
      method: 'GET',
    });
    const bot = response?.bot || response?.data?.bot;
    if (!bot?.open_id) throw new Error('飞书“获取机器人信息”接口未返回 bot.open_id');
    return { openId: bot.open_id, name: bot.app_name || this.config.botName };
  }

  async send(chatId, text, mentions = [], { receiveIdType = 'chat_id' } = {}) {
    const prefix = mentions
      .filter((item) => item?.openId)
      .map((item) => `<at user_id="${escapeAttribute(item.openId)}">${escapeText(item.name || '用户')}</at>`)
      .join(' ');
    const content = prefix ? `${prefix} ${text}` : text;
    await this.client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: content }),
      },
    });
  }

  async sendUser(openId, text, mentions = []) {
    return this.send(openId, text, mentions, { receiveIdType: 'open_id' });
  }

  start(onMessage) {
    const dispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (payload) => {
        try {
          await onMessage(normalizeMessageEvent(payload));
        } catch (error) {
          console.error('[feishu] 处理消息失败:', error);
        }
      },
    });
    this.ws = new WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: LoggerLevel.info,
    });
    this.ws.start({ eventDispatcher: dispatcher });
  }
}

export function normalizeMessageEvent(payload) {
  const event = payload?.event ?? payload;
  const message = event?.message ?? {};
  let text = '';
  try {
    const content = JSON.parse(message.content || '{}');
    text = content.text || '';
  } catch {
    text = '';
  }
  return {
    messageId: message.message_id,
    chatId: message.chat_id,
    chatType: message.chat_type,
    messageType: message.message_type,
    text,
    mentions: message.mentions || [],
    senderOpenId: event?.sender?.sender_id?.open_id,
    senderType: event?.sender?.sender_type,
  };
}

function escapeText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttribute(value) {
  return escapeText(value).replaceAll('"', '&quot;');
}
