import { Bot } from 'grammy';
import { Pool } from 'pg';
import { isAuthorizedAdmin } from './auth';
import { addTag, getBroadcast, getStats, removeTag, setBroadcastStatus } from '../db/queries';

export function registerAdminCommands(bot: Bot, pool: Pool): void {
  bot.command('stats', async (ctx) => {
    console.log(`/stats received from telegram_id=${ctx.from?.id}`);
    if (!isAuthorizedAdmin(ctx)) {
      return;
    }

    const stats = await getStats(pool);
    const text = [
      `Total users: ${stats.total}`,
      `Clicked: ${stats.clicked}`,
      `Not clicked: ${stats.notClicked}`,
      `Blocked: ${stats.blocked}`,
      `Sends in last 7 days: ${stats.sendsLast7Days}`,
    ].join('\n');
    await ctx.reply(text);
  });

  bot.command('tag', async (ctx) => {
    console.log(`/tag received from telegram_id=${ctx.from?.id}`);
    if (!isAuthorizedAdmin(ctx)) {
      return;
    }

    const parts = (ctx.message?.text ?? '').split(/\s+/).filter(Boolean);
    const telegramId = Number(parts[1]);
    const tag = parts[2];
    if (!parts[1] || Number.isNaN(telegramId) || !tag) {
      await ctx.reply('Usage: /tag <telegram_id> <tag>');
      return;
    }

    const applied = await addTag(pool, telegramId, tag);
    await ctx.reply(
      applied ? `Tagged ${telegramId} with ${tag}.` : 'No change. User may not exist or already has that tag.'
    );
  });

  bot.command('untag', async (ctx) => {
    console.log(`/untag received from telegram_id=${ctx.from?.id}`);
    if (!isAuthorizedAdmin(ctx)) {
      return;
    }

    const parts = (ctx.message?.text ?? '').split(/\s+/).filter(Boolean);
    const telegramId = Number(parts[1]);
    const tag = parts[2];
    if (!parts[1] || Number.isNaN(telegramId) || !tag) {
      await ctx.reply('Usage: /untag <telegram_id> <tag>');
      return;
    }

    const removed = await removeTag(pool, telegramId, tag);
    await ctx.reply(
      removed ? `Removed ${tag} from ${telegramId}.` : 'No change. User may not exist or did not have that tag.'
    );
  });

  bot.command('cancel', async (ctx) => {
    console.log(`/cancel received from telegram_id=${ctx.from?.id}`);
    if (!isAuthorizedAdmin(ctx)) {
      return;
    }

    const parts = (ctx.message?.text ?? '').split(/\s+/).filter(Boolean);
    const broadcastId = Number(parts[1]);
    if (!parts[1] || Number.isNaN(broadcastId)) {
      await ctx.reply('Usage: /cancel <broadcast_id>');
      return;
    }

    const broadcast = await getBroadcast(pool, broadcastId);
    if (!broadcast || (broadcast.status !== 'draft' && broadcast.status !== 'approved')) {
      await ctx.reply('That broadcast cannot be cancelled.');
      return;
    }

    await setBroadcastStatus(pool, broadcastId, 'cancelled');
    await ctx.reply(`Broadcast ${broadcastId} cancelled.`);
  });
}
