import cron from 'node-cron';
import { Bot } from 'grammy';
import { Pool } from 'pg';
import { getBackupLinkEligibleUserIds, markBackupLinkSent } from '../db/queries';
import { sendToRecipients } from '../bot/sender';

const BACKUP_LINK_CAMPAIGN_KEY = 'backup_link';

// Optional backup group message, sent 1 minute after /start. Only runs when
// BACKUP_GROUP_URL is set. Step 3 of the /start sequence already sends the main
// WhatsApp group, so leave BACKUP_GROUP_URL unset unless a separate backup exists.
function backupLinkText(url: string): string {
  return [
    'This is important. Please join both.',
    '',
    'The Telegram group above is our main channel, but platforms occasionally have issues outside our control, and we have seen it happen before. The WhatsApp group below is our backup, so if anything ever affects Telegram, you do not miss event updates, reminders, or your seat confirmation.',
    '',
    'Join it now, it takes ten seconds:',
    '',
    url,
    '',
    'Both groups take less than a minute combined. Do not skip this one.',
  ].join('\n');
}

let runInFlight = false;

async function runBackupLinkStep(bot: Bot, pool: Pool, url: string): Promise<void> {
  if (runInFlight) {
    return;
  }
  runInFlight = true;
  try {
    const recipientIds = await getBackupLinkEligibleUserIds(pool);
    if (recipientIds.length === 0) {
      return;
    }

    await sendToRecipients(bot, pool, recipientIds, backupLinkText(url), {
      campaignKey: BACKUP_LINK_CAMPAIGN_KEY,
      onResult: async (telegramId, outcome) => {
        console.log(`Backup link send to telegram_id=${telegramId} outcome=${outcome}`);
        if (outcome !== 'failed') {
          await markBackupLinkSent(pool, telegramId);
        }
      },
    });
  } finally {
    runInFlight = false;
  }
}

export function startBackupLinkJob(bot: Bot, pool: Pool, url: string): void {
  runBackupLinkStep(bot, pool, url).catch((err) => {
    console.error('Backup link catch-up run failed', err);
  });

  cron.schedule('*/15 * * * * *', async () => {
    try {
      await runBackupLinkStep(bot, pool, url);
    } catch (err) {
      console.error('Backup link job failed', err);
    }
  });
}
