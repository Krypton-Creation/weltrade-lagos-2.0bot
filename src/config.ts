import 'dotenv/config';

const errors: string[] = [];

// Matches the placeholder values used in .env.example, so a copied but unedited
// .env fails at startup instead of running with fake values.
function isPlaceholder(value: string): boolean {
  return /^your_|_here$|placeholder|changeme|^<.*>$|@host:/i.test(value);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    errors.push(`${name} is missing`);
    return '';
  }
  if (isPlaceholder(value)) {
    errors.push(`${name} is still a placeholder value`);
    return '';
  }
  return value;
}

function optionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) {
    return null;
  }
  if (isPlaceholder(value)) {
    errors.push(`${name} is still a placeholder value. Set a real value or remove it`);
    return null;
  }
  return value;
}

function requireUrl(name: string): string {
  const value = requireEnv(name);
  if (value && !/^https:\/\/\S+$/.test(value)) {
    errors.push(`${name} must be a full https:// link`);
  }
  return value;
}

function optionalUrl(name: string): string | null {
  const value = optionalEnv(name);
  if (value !== null && !/^https:\/\/\S+$/.test(value)) {
    errors.push(`${name} must be a full https:// link`);
  }
  return value;
}

function requireNumber(name: string): number {
  const value = requireEnv(name);
  if (value && !/^-?\d+$/.test(value)) {
    errors.push(`${name} must be a whole number`);
  }
  return Number(value);
}

function requireIsoDate(name: string): string {
  const value = requireEnv(name);
  if (!value) {
    return value;
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = match ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])) : null;
  if (!match || !date || date.getUTCMonth() !== +match[2] - 1 || date.getUTCDate() !== +match[3]) {
    errors.push(`${name} must be a real date in YYYY-MM-DD format`);
  }
  return value;
}

function delaySeconds(name: string, fallback: number): number {
  const value = optionalEnv(name);
  if (value === null) {
    return fallback;
  }
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    errors.push(`${name} must be a whole number of seconds, 1 or more`);
  }
  return Number(value);
}

function parseAdminUserIds(raw: string): number[] {
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .map((id) => Number(id));
}

export const config = {
  botToken: requireEnv('BOT_TOKEN'),
  databaseUrl: requireEnv('DATABASE_URL'),
  channelId: requireEnv('CHANNEL_ID'),
  adminChatId: requireNumber('ADMIN_CHAT_ID'),
  adminUserIds: parseAdminUserIds(requireEnv('ADMIN_USER_IDS')),

  eventName: requireEnv('EVENT_NAME'),
  eventDateIso: requireIsoDate('EVENT_DATE_ISO'),
  eventTimeLabel: requireEnv('EVENT_TIME_LABEL'),
  eventVenue: requireEnv('EVENT_VENUE'),

  groupUrl: requireUrl('GROUP_URL'),
  eventbriteUrl: requireUrl('EVENTBRITE_URL'),
  whatsappGroupUrl: requireUrl('WHATSAPP_GROUP_URL'),
  backupGroupUrl: optionalUrl('BACKUP_GROUP_URL'),

  step2DelaySeconds: delaySeconds('STEP2_DELAY_SECONDS', 60),
  step3DelaySeconds: delaySeconds('STEP3_DELAY_SECONDS', 60),
};

// Names only. Never log values: they include the bot token and database URL.
const ENV_NAMES = [
  'ADMIN_CHAT_ID',
  'ADMIN_USER_IDS',
  'BOT_TOKEN',
  'CHANNEL_ID',
  'DATABASE_URL',
  'EVENT_DATE_ISO',
  'EVENT_NAME',
  'EVENT_TIME_LABEL',
  'EVENT_VENUE',
  'EVENTBRITE_URL',
  'GROUP_URL',
  'STEP2_DELAY_SECONDS',
  'STEP3_DELAY_SECONDS',
  'WHATSAPP_GROUP_URL',
  'BACKUP_GROUP_URL',
];

console.log(
  `Env check: ${ENV_NAMES.map((name) => `${name}=${process.env[name]?.trim() ? 'set' : 'missing'}`).join(' ')}`
);

if (errors.length > 0) {
  throw new Error(
    `Invalid environment configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}\n` +
      'Set these in Railway (or .env locally). See .env.example for the full list.'
  );
}
