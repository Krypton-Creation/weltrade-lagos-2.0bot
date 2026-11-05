import { Bot, GrammyError, HttpError } from 'grammy';
import { Pool } from 'pg';
import { config } from '../config';
import { upsertUser } from '../db/queries';
import { registerStartHandler } from './start';
import { registerBroadcastFlow } from '../admin/broadcast';
import { registerAdminCommands } from '../admin/commands';
import { registerChannelPostFlow } from '../admin/post';
import { registerInboxHandler } from './inbox';
import { botSequenceSender } from '../jobs/sequence';

export function createBot(pool: Pool): Bot {
  const bot = new Bot(config.botToken);

  bot.use(async (ctx, next) => {
    const user = ctx.from;
    if (user && !user.is_bot) {
      await upsertUser(pool, {
        telegramId: user.id,
        firstName: user.first_name,
        lastName: user.last_name,
        username: user.username,
      });
    }
    await next();
  });

  registerStartHandler(bot, pool, botSequenceSender(bot, pool));
  registerBroadcastFlow(bot, pool);
  registerAdminCommands(bot, pool);
  registerChannelPostFlow(bot, pool);
  registerInboxHandler(bot, pool);

  bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`);
    const cause = err.error;
    if (cause instanceof GrammyError) {
      console.error('Error in request:', cause.description);
    } else if (cause instanceof HttpError) {
      console.error('Could not contact Telegram:', cause);
    } else if (cause instanceof Error) {
      console.error('Unknown error:', cause.message);
      console.error(cause.stack);
    } else {
      console.error('Unknown error object:', cause);
    }
  });

  return bot;
}
