import { Bot } from 'grammy';
import { User } from 'grammy/types';
import { Pool } from 'pg';
import { config } from '../config';
import { isAdminUser } from '../admin/auth';
import { logIncomingMessage } from '../db/queries';

const AUTO_REPLY_TEXT =
  'Thanks for your message. Someone from the team will get back to you shortly.';
const AUTO_REPLY_COOLDOWN_MS = 60 * 60 * 1000;

const lastAutoReplyAt = new Map<number, number>();

function shouldAutoReply(telegramId: number): boolean {
  const now = Date.now();
  const last = lastAutoReplyAt.get(telegramId);
  if (last !== undefined && now - last < AUTO_REPLY_COOLDOWN_MS) {
    return false;
  }
  lastAutoReplyAt.set(telegramId, now);
  return true;
}

function senderLabel(user: User): string {
  const username = user.username ? `@${user.username}` : 'no username';
  return `${user.first_name} (${username}, telegram_id=${user.id})`;
}

export function registerInboxHandler(bot: Bot, pool: Pool): void {
  bot.on('message', async (ctx, next) => {
    if (ctx.chat.type !== 'private') {
      await next();
      return;
    }

    const user = ctx.from;
    if (!user || isAdminUser(user.id)) {
      await next();
      return;
    }

    console.log(`DM received from telegram_id=${user.id}`);
    await logIncomingMessage(pool, user.id);

    await bot.api.sendMessage(config.adminChatId, `Message from ${senderLabel(user)}:`);
    await bot.api.forwardMessage(config.adminChatId, ctx.chat.id, ctx.message.message_id);

    if (shouldAutoReply(user.id)) {
      await ctx.reply(AUTO_REPLY_TEXT);
    }
  });
}
