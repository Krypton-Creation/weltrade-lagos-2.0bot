import { Pool } from 'pg';
import { config } from './config';
import { runMigrations } from './db/migrate';
import { createBot } from './bot';
import { startBackupLinkJob } from './jobs/backupLink';
import { botSequenceSender, startSequenceJob } from './jobs/sequence';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: config.databaseUrl });

  await runMigrations(pool);

  const bot = createBot(pool);
  startSequenceJob(pool, botSequenceSender(bot, pool));
  if (config.backupGroupUrl) {
    startBackupLinkJob(bot, pool, config.backupGroupUrl);
  } else {
    console.log('BACKUP_GROUP_URL not set, backup link job is off');
  }

  console.log('Starting bot polling...');
  await bot.start({
    onStart: (botInfo) => {
      console.log(`Bot polling started as @${botInfo.username}`);
    },
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
