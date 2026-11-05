import { Bot, GrammyError, InlineKeyboard } from 'grammy';
import { Pool } from 'pg';
import { insertSend, markBlocked, SendStatus } from '../db/queries';

const RATE_LIMIT_PER_SECOND = 20;
const INTERVAL_MS = 1000 / RATE_LIMIT_PER_SECOND;

let sendQueue: Promise<void> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throttle<T>(fn: () => Promise<T>): Promise<T> {
  const run = sendQueue.then(fn, fn);
  sendQueue = run.then(
    () => sleep(INTERVAL_MS),
    () => sleep(INTERVAL_MS)
  );
  return run;
}

export interface SendTarget {
  broadcastId?: number;
  campaignKey?: string;
  replyMarkup?: InlineKeyboard;
  onResult?: (telegramId: number, outcome: Outcome) => Promise<void> | void;
}

export interface SendResult {
  sent: number;
  failed: number;
  blocked: number;
  skipped: number;
}

type Outcome = 'sent' | 'failed' | 'blocked' | 'skipped';

export async function sendToRecipients(
  bot: Bot,
  pool: Pool,
  recipientIds: number[],
  text: string,
  target: SendTarget
): Promise<SendResult> {
  const result: SendResult = { sent: 0, failed: 0, blocked: 0, skipped: 0 };

  for (const telegramId of recipientIds) {
    const outcome = await throttle(() => deliverOne(bot, pool, telegramId, text, target));
    result[outcome]++;
    if (target.onResult) {
      await target.onResult(telegramId, outcome);
    }
  }

  return result;
}

async function sendMessage(
  bot: Bot,
  telegramId: number,
  text: string,
  target: SendTarget
): Promise<void> {
  const sentMessage = await bot.api.sendMessage(
    telegramId,
    text,
    target.replyMarkup ? { reply_markup: target.replyMarkup } : undefined
  );
  if (sentMessage.chat.id !== telegramId) {
    throw new Error(
      `Telegram delivered to chat ${sentMessage.chat.id}, expected ${telegramId}`
    );
  }
}

async function classifyError(
  pool: Pool,
  telegramId: number,
  err: unknown
): Promise<[SendStatus, string]> {
  if (err instanceof GrammyError && err.error_code === 403) {
    console.error(`Send to ${telegramId} got 403: ${err.description}`);
    if (err.description.includes('bot was blocked by the user')) {
      await markBlocked(pool, telegramId);
      return ['blocked', err.description];
    }
    return ['failed', err.description];
  }
  if (err instanceof GrammyError) {
    console.error(`Send to ${telegramId} failed: ${err.error_code} ${err.description}`);
    return ['failed', err.description];
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Send to ${telegramId} failed with a non-Telegram error: ${message}`);
  return ['failed', message];
}

async function attemptDelivery(
  bot: Bot,
  pool: Pool,
  telegramId: number,
  text: string,
  target: SendTarget
): Promise<[SendStatus, string | undefined]> {
  try {
    await sendMessage(bot, telegramId, text, target);
    return ['sent', undefined];
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 429) {
      const retryAfter = err.parameters?.retry_after ?? 1;
      await sleep(retryAfter * 1000);
      try {
        await sendMessage(bot, telegramId, text, target);
        return ['sent', undefined];
      } catch (retryErr) {
        return classifyError(pool, telegramId, retryErr);
      }
    }
    return classifyError(pool, telegramId, err);
  }
}

async function deliverOne(
  bot: Bot,
  pool: Pool,
  telegramId: number,
  text: string,
  target: SendTarget
): Promise<Outcome> {
  try {
    const [status, error] = await attemptDelivery(bot, pool, telegramId, text, target);

    const recorded = await insertSend(pool, {
      broadcastId: target.broadcastId,
      campaignKey: target.campaignKey,
      telegramId,
      status,
      error,
    });

    return recorded ? status : 'skipped';
  } catch (unexpected) {
    console.error(`Unexpected error sending to ${telegramId}`, unexpected);
    return 'failed';
  }
}

// Single throttled send that reports the real delivery status. The sends row is a
// log only: a duplicate (for example a retry after an earlier failure) is ignored
// instead of turning the result into 'skipped'. Callers keep their own state.
export async function sendOne(
  bot: Bot,
  pool: Pool,
  telegramId: number,
  text: string,
  target: SendTarget
): Promise<[SendStatus, string | undefined]> {
  return throttle(async () => {
    const [status, error] = await attemptDelivery(bot, pool, telegramId, text, target);
    await insertSend(pool, {
      broadcastId: target.broadcastId,
      campaignKey: target.campaignKey,
      telegramId,
      status,
      error,
    }).catch((err) => console.error(`Could not log send to ${telegramId}`, err));
    return [status, error];
  });
}
