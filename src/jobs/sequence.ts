import cron from 'node-cron';
import { Bot, InlineKeyboard } from 'grammy';
import { Pool } from 'pg';
import { config } from '../config';
import {
  claimSequenceStep,
  getDueSequenceSteps,
  recordSequenceStepBlocked,
  recordSequenceStepFailure,
  recordSequenceStepSent,
  SendStatus,
  SequenceStep,
} from '../db/queries';
import { sendOne } from '../bot/sender';

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_SECONDS = 60;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function eventDateParts(): { month: string; day: number; year: number } {
  const [year, month, day] = config.eventDateIso.split('-').map(Number);
  return { month: MONTHS[month - 1], day, year };
}

function ordinal(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) {
    return `${day}th`;
  }
  return `${day}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] ?? 'th'}`;
}

// e.g. "November 28, 2026"
export function eventDateLabel(): string {
  const { month, day, year } = eventDateParts();
  return `${month} ${day}, ${year}`;
}

// e.g. "November 28th"
export function eventDateShort(): string {
  const { month, day } = eventDateParts();
  return `${month} ${ordinal(day)}`;
}

// The only emojis allowed in bot copy: the three label emojis in Message 1.
const EMOJI_DATE = '\u{1F4C5}';
const EMOJI_VENUE = '\u{1F4CD}';
const EMOJI_TIME = '\u{23F0}';

export function step1Text(): string {
  return [
    'Hey Lasgidi!',
    '',
    "Did you miss us? We're back!",
    '',
    'The first edition was a blast. The energy was incredible and the experience was unforgettable.',
    '',
    "Now Weltrade is bringing it back, and we're going bigger with the WELTRADE LAGOS SYNTHETIC TRADING SUMMIT 2.0!",
    '',
    "Lagos, everyone is invited! Whether you're curious about synthetic trading, just starting out, or already in the industry, this is your chance to learn, connect with other synthetic traders, explore market insights and discover new strategies.",
    '',
    'And guess what? Entry is absolutely free!',
    '',
    `${EMOJI_DATE} Date: ${eventDateLabel()}`,
    `${EMOJI_VENUE} Venue: ${config.eventVenue}`,
    `${EMOJI_TIME} Time: ${config.eventTimeLabel}`,
    '',
    'Giveaway and refreshments will be provided.',
    '',
    `Lagos, don't just hear the stories this time. Come and experience it for yourself. Save the date: ${eventDateShort()}. See you there!`,
    '',
    'First, join our Telegram group below so you get every update.',
  ].join('\n');
}

const STEP2_TEXT =
  'Next step: register for the summit on Eventbrite to get your free ticket for the day. It takes about a minute.';

const STEP3_TEXT =
  'Last step: join our WhatsApp group. Our team shares updates there and will be in touch with you.';

export const TELEGRAM_BUTTON_LABEL = 'Join our Telegram group';
export const EVENTBRITE_BUTTON_LABEL = 'Register on Eventbrite';
export const WHATSAPP_BUTTON_LABEL = 'Join the WhatsApp group';

interface StepMessage {
  text: string;
  keyboard: InlineKeyboard;
}

export function stepMessage(step: SequenceStep): StepMessage {
  if (step === 1) {
    return { text: step1Text(), keyboard: new InlineKeyboard().url(TELEGRAM_BUTTON_LABEL, config.groupUrl) };
  }
  if (step === 2) {
    return { text: STEP2_TEXT, keyboard: new InlineKeyboard().url(EVENTBRITE_BUTTON_LABEL, config.eventbriteUrl) };
  }
  return { text: STEP3_TEXT, keyboard: new InlineKeyboard().url(WHATSAPP_BUTTON_LABEL, config.whatsappGroupUrl) };
}

export function allLinksKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .url(TELEGRAM_BUTTON_LABEL, config.groupUrl)
    .row()
    .url(EVENTBRITE_BUTTON_LABEL, config.eventbriteUrl)
    .row()
    .url(WHATSAPP_BUTTON_LABEL, config.whatsappGroupUrl);
}

export function repeatStartText(): string {
  return `Welcome back. Here are your links for the ${config.eventName} again.`;
}

function nextDelaySeconds(step: SequenceStep): number | null {
  if (step === 1) {
    return config.step2DelaySeconds;
  }
  if (step === 2) {
    return config.step3DelaySeconds;
  }
  return null;
}

export type SequenceSender = (
  telegramId: number,
  step: SequenceStep,
  message: StepMessage
) => Promise<[SendStatus, string | undefined]>;

export function botSequenceSender(bot: Bot, pool: Pool): SequenceSender {
  return (telegramId, step, message) =>
    sendOne(bot, pool, telegramId, message.text, {
      campaignKey: `lagos2_step${step}`,
      replyMarkup: message.keyboard,
    });
}

// Sends one step to one user if it is still pending and nobody else holds it.
export async function runSequenceStep(
  pool: Pool,
  send: SequenceSender,
  telegramId: number,
  step: SequenceStep
): Promise<void> {
  if (!(await claimSequenceStep(pool, telegramId, step))) {
    return;
  }

  let status: SendStatus;
  let error: string | undefined;
  try {
    [status, error] = await send(telegramId, step, stepMessage(step));
  } catch (err) {
    status = 'failed';
    error = err instanceof Error ? err.message : String(err);
  }

  if (status === 'sent') {
    await recordSequenceStepSent(pool, telegramId, step, nextDelaySeconds(step));
    console.log(`Sequence send telegram_id=${telegramId} step=${step} ok`);
  } else if (status === 'blocked') {
    await recordSequenceStepBlocked(pool, telegramId, step);
    console.log(`Sequence send telegram_id=${telegramId} step=${step} error=blocked, sequence stopped`);
  } else {
    const next = await recordSequenceStepFailure(pool, telegramId, step, MAX_ATTEMPTS, RETRY_DELAY_SECONDS);
    console.log(
      `Sequence send telegram_id=${telegramId} step=${step} error=${error ?? 'unknown'} ${
        next === 'failed' ? 'giving up' : `retry in ${RETRY_DELAY_SECONDS}s`
      }`
    );
  }
}

let tickInFlight = false;

export async function runSequenceTick(pool: Pool, send: SequenceSender): Promise<void> {
  if (tickInFlight) {
    return;
  }
  tickInFlight = true;
  try {
    const due = await getDueSequenceSteps(pool);
    for (const { telegramId, step } of due) {
      try {
        await runSequenceStep(pool, send, telegramId, step);
      } catch (err) {
        console.error(`Sequence step ${step} for telegram_id=${telegramId} failed`, err);
      }
    }
  } finally {
    tickInFlight = false;
  }
}

export function startSequenceJob(pool: Pool, send: SequenceSender): void {
  runSequenceTick(pool, send).catch((err) => {
    console.error('Sequence catch-up run failed', err);
  });

  cron.schedule('*/15 * * * * *', async () => {
    try {
      await runSequenceTick(pool, send);
    } catch (err) {
      console.error('Sequence job failed', err);
    }
  });
}
