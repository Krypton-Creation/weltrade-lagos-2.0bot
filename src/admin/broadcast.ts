import { Bot, InlineKeyboard } from 'grammy';
import { Pool } from 'pg';
import { config } from '../config';
import { isAuthorizedAdmin } from './auth';
import {
  completeBroadcast,
  countSegmentUsers,
  createBroadcast,
  getBroadcast,
  getSegmentUserIds,
  isValidSegment,
  setBroadcastApproved,
  setBroadcastStatus,
} from '../db/queries';
import { sendToRecipients } from '../bot/sender';

const pendingDrafts = new Map<number, string>();

function parseBroadcastSegment(text: string): string | null {
  const match = text.match(/^\/broadcast(?:@\S+)?\s+(\S+)/);
  return match ? match[1] : null;
}

async function postPreview(bot: Bot, pool: Pool, broadcastId: number): Promise<void> {
  const broadcast = await getBroadcast(pool, broadcastId);
  if (!broadcast) {
    return;
  }

  const count = await countSegmentUsers(pool, broadcast.segment);
  const preview = [
    broadcast.body,
    '',
    `Segment: ${broadcast.segment}`,
    `Recipients: ${count}`,
  ].join('\n');

  const keyboard = new InlineKeyboard()
    .text('Approve and send', `bcast_approve_${broadcastId}`)
    .text('Cancel', `bcast_cancel_${broadcastId}`);

  await bot.api.sendMessage(config.adminChatId, preview, { reply_markup: keyboard });
  console.log(
    `Broadcast ${broadcastId} preview sent to admin_chat_id=${config.adminChatId} segment=${broadcast.segment} recipients=${count}`
  );
}

export function registerBroadcastFlow(bot: Bot, pool: Pool): void {
  bot.command('broadcast', async (ctx) => {
    console.log(`/broadcast received from telegram_id=${ctx.from?.id}`);
    if (!isAuthorizedAdmin(ctx)) {
      console.log(
        `/broadcast rejected: telegram_id=${ctx.from?.id} chat_id=${ctx.chat?.id} admin_chat_id=${config.adminChatId}`
      );
      await ctx.reply('Not authorised for broadcast. Check ADMIN_CHAT_ID.');
      return;
    }

    const text = ctx.message?.text ?? '';
    const segment = parseBroadcastSegment(text);
    if (!segment || !isValidSegment(segment)) {
      await ctx.reply('Usage: /broadcast <segment>. Segments: all, not_clicked, clicked, tag:<name>');
      return;
    }

    const adminId = ctx.from!.id;
    const replyBody = ctx.message?.reply_to_message?.text;

    if (replyBody) {
      const broadcastId = await createBroadcast(pool, replyBody, segment, adminId);
      await postPreview(bot, pool, broadcastId);
      return;
    }

    pendingDrafts.set(adminId, segment);
    await ctx.reply('Send the message body for this broadcast as your next message.');
  });

  bot.on('message:text', async (ctx, next) => {
    if (!isAuthorizedAdmin(ctx) || ctx.message.text.startsWith('/')) {
      await next();
      return;
    }

    const adminId = ctx.from!.id;
    const segment = pendingDrafts.get(adminId);
    if (!segment) {
      await next();
      return;
    }

    pendingDrafts.delete(adminId);
    const broadcastId = await createBroadcast(pool, ctx.message.text, segment, adminId);
    await postPreview(bot, pool, broadcastId);
  });

  bot.callbackQuery(/^bcast_approve_(\d+)$/, async (ctx) => {
    console.log(
      `Broadcast approve pressed: data=${ctx.callbackQuery.data} telegram_id=${ctx.from.id} chat_id=${ctx.chat?.id}`
    );
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const match = ctx.match as RegExpMatchArray;
    const broadcastId = Number(match[1]);
    const broadcast = await getBroadcast(pool, broadcastId);
    if (!broadcast || broadcast.status !== 'draft') {
      await ctx.answerCallbackQuery({ text: 'This broadcast is no longer pending.', show_alert: true });
      return;
    }

    const approverId = ctx.from.id;
    const multipleAdmins = config.adminUserIds.length > 1;
    if (multipleAdmins && approverId === broadcast.createdBy) {
      await ctx.answerCallbackQuery({
        text: 'A different admin must approve this broadcast.',
        show_alert: true,
      });
      return;
    }

    await setBroadcastApproved(pool, broadcastId, approverId);
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup();
    await bot.api.sendMessage(config.adminChatId, `Broadcast ${broadcastId} approved. Sending now.`);

    await setBroadcastStatus(pool, broadcastId, 'sending');
    const recipientIds = await getSegmentUserIds(pool, broadcast.segment);
    const result = await sendToRecipients(bot, pool, recipientIds, broadcast.body, { broadcastId });
    await completeBroadcast(pool, broadcastId, result.sent, result.failed + result.blocked);

    await bot.api.sendMessage(
      config.adminChatId,
      `Broadcast ${broadcastId} complete. Sent: ${result.sent}. Blocked: ${result.blocked}. Failed: ${result.failed}.`
    );
  });

  bot.callbackQuery(/^bcast_cancel_(\d+)$/, async (ctx) => {
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const match = ctx.match as RegExpMatchArray;
    const broadcastId = Number(match[1]);
    const broadcast = await getBroadcast(pool, broadcastId);
    if (!broadcast || (broadcast.status !== 'draft' && broadcast.status !== 'approved')) {
      await ctx.answerCallbackQuery({ text: 'This broadcast cannot be cancelled now.', show_alert: true });
      return;
    }

    await setBroadcastStatus(pool, broadcastId, 'cancelled');
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup();
    await bot.api.sendMessage(config.adminChatId, `Broadcast ${broadcastId} cancelled.`);
  });
}
