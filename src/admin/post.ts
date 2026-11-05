import { Bot, InlineKeyboard } from 'grammy';
import { Pool } from 'pg';
import { config } from '../config';
import { isAuthorizedAdmin } from './auth';
import {
  completeChannelPost,
  createChannelPost,
  getChannelPost,
  listRecentChannelPosts,
  setChannelPostApproved,
  setChannelPostStatus,
} from '../db/queries';

const pendingDrafts = new Set<number>();

async function postPreview(bot: Bot, pool: Pool, postId: number): Promise<void> {
  const post = await getChannelPost(pool, postId);
  if (!post) {
    return;
  }

  const preview = [post.body, '', 'Destination: channel'].join('\n');

  const keyboard = new InlineKeyboard()
    .text('Approve and send', `post_approve_${postId}`)
    .text('Cancel', `post_cancel_${postId}`);

  await bot.api.sendMessage(config.adminChatId, preview, { reply_markup: keyboard });
}

export function registerChannelPostFlow(bot: Bot, pool: Pool): void {
  bot.command('post', async (ctx) => {
    console.log(`/post received from telegram_id=${ctx.from?.id}`);
    if (!isAuthorizedAdmin(ctx)) {
      return;
    }

    const adminId = ctx.from!.id;
    const replyBody = ctx.message?.reply_to_message?.text;

    if (replyBody) {
      const postId = await createChannelPost(pool, replyBody, adminId);
      await postPreview(bot, pool, postId);
      return;
    }

    pendingDrafts.add(adminId);
    await ctx.reply('Send the message body for this channel post as your next message.');
  });

  bot.on('message:text', async (ctx, next) => {
    if (!isAuthorizedAdmin(ctx) || ctx.message.text.startsWith('/')) {
      await next();
      return;
    }

    const adminId = ctx.from!.id;
    if (!pendingDrafts.has(adminId)) {
      await next();
      return;
    }

    pendingDrafts.delete(adminId);
    const postId = await createChannelPost(pool, ctx.message.text, adminId);
    await postPreview(bot, pool, postId);
  });

  bot.callbackQuery(/^post_approve_(\d+)$/, async (ctx) => {
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const match = ctx.match as RegExpMatchArray;
    const postId = Number(match[1]);
    const post = await getChannelPost(pool, postId);
    if (!post || post.status !== 'draft') {
      await ctx.answerCallbackQuery({ text: 'This post is no longer pending.', show_alert: true });
      return;
    }

    const approverId = ctx.from.id;
    const multipleAdmins = config.adminUserIds.length > 1;
    if (multipleAdmins && approverId === post.createdBy) {
      await ctx.answerCallbackQuery({
        text: 'A different admin must approve this post.',
        show_alert: true,
      });
      return;
    }

    await setChannelPostApproved(pool, postId, approverId);
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup();

    const sent = await bot.api.sendMessage(config.channelId, post.body);
    await completeChannelPost(pool, postId, sent.message_id);

    await bot.api.sendMessage(config.adminChatId, `Post ${postId} sent to the channel.`);
  });

  bot.callbackQuery(/^post_cancel_(\d+)$/, async (ctx) => {
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const match = ctx.match as RegExpMatchArray;
    const postId = Number(match[1]);
    const post = await getChannelPost(pool, postId);
    if (!post || (post.status !== 'draft' && post.status !== 'approved')) {
      await ctx.answerCallbackQuery({ text: 'This post cannot be cancelled now.', show_alert: true });
      return;
    }

    await setChannelPostStatus(pool, postId, 'cancelled');
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup();
    await bot.api.sendMessage(config.adminChatId, `Post ${postId} cancelled.`);
  });

  bot.command('posts', async (ctx) => {
    console.log(`/posts received from telegram_id=${ctx.from?.id}`);
    if (!isAuthorizedAdmin(ctx)) {
      return;
    }

    const posts = await listRecentChannelPosts(pool, 10);
    if (posts.length === 0) {
      await ctx.reply('No channel posts yet.');
      return;
    }

    const lines = posts.map((post) => {
      const snippet = post.body.length > 60 ? `${post.body.slice(0, 60)}...` : post.body;
      return `#${post.id} [${post.status}] ${snippet}`;
    });
    await ctx.reply(lines.join('\n'));
  });
}
