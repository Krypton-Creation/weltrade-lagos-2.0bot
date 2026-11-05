import { Bot } from 'grammy';
import { Pool } from 'pg';
import { config } from '../config';
import { scheduleBackupLink, startSequence } from '../db/queries';
import {
  allLinksKeyboard,
  repeatStartText,
  runSequenceStep,
  SequenceSender,
} from '../jobs/sequence';

export function registerStartHandler(bot: Bot, pool: Pool, send: SequenceSender): void {
  bot.command('start', async (ctx) => {
    console.log(`/start received from telegram_id=${ctx.from?.id}`);
    if (!ctx.from || ctx.chat.type !== 'private') {
      return;
    }

    const started = await startSequence(pool, ctx.from.id);
    if (!started) {
      console.log(`/start repeat from telegram_id=${ctx.from.id}, re-sending links only`);
      await ctx.reply(repeatStartText(), { reply_markup: allLinksKeyboard() });
      return;
    }

    if (config.backupGroupUrl) {
      await scheduleBackupLink(pool, ctx.from.id);
    }
    await runSequenceStep(pool, send, ctx.from.id, 1);
  });
}
