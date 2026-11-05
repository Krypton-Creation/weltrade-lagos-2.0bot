import { Pool } from 'pg';

export interface TelegramUserInfo {
  telegramId: number;
  firstName?: string;
  lastName?: string;
  username?: string;
}

export async function upsertUser(pool: Pool, user: TelegramUserInfo): Promise<void> {
  await pool.query(
    `INSERT INTO users (telegram_id, first_name, last_name, username, last_seen_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (telegram_id) DO UPDATE SET
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       username = EXCLUDED.username,
       last_seen_at = now()`,
    [user.telegramId, user.firstName ?? null, user.lastName ?? null, user.username ?? null]
  );
}

export async function markBlocked(pool: Pool, telegramId: number): Promise<void> {
  await pool.query(`UPDATE users SET blocked = true, blocked_at = now() WHERE telegram_id = $1`, [
    telegramId,
  ]);
}

export async function addTag(pool: Pool, telegramId: number, tag: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE users SET tags = array_append(tags, $2)
     WHERE telegram_id = $1 AND NOT ($2 = ANY(tags))`,
    [telegramId, tag]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function removeTag(pool: Pool, telegramId: number, tag: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE users SET tags = array_remove(tags, $2) WHERE telegram_id = $1 AND $2 = ANY(tags)`,
    [telegramId, tag]
  );
  return (result.rowCount ?? 0) > 0;
}

interface SegmentCondition {
  where: string;
  params: unknown[];
}

export function resolveSegmentCondition(segment: string): SegmentCondition {
  if (segment === 'all') {
    return { where: 'blocked = false', params: [] };
  }
  if (segment === 'not_clicked') {
    return { where: 'group_clicked = false AND blocked = false', params: [] };
  }
  if (segment === 'clicked') {
    return { where: 'group_clicked = true AND blocked = false', params: [] };
  }
  if (segment.startsWith('tag:') && segment.length > 4) {
    const tag = segment.slice(4);
    return { where: 'blocked = false AND $1 = ANY(tags)', params: [tag] };
  }
  throw new Error(`Unknown segment: ${segment}`);
}

export function isValidSegment(segment: string): boolean {
  try {
    resolveSegmentCondition(segment);
    return true;
  } catch {
    return false;
  }
}

export async function countSegmentUsers(pool: Pool, segment: string): Promise<number> {
  const { where, params } = resolveSegmentCondition(segment);
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM users WHERE ${where}`,
    params
  );
  return result.rows[0].count;
}

export async function getSegmentUserIds(pool: Pool, segment: string): Promise<number[]> {
  const { where, params } = resolveSegmentCondition(segment);
  const result = await pool.query<{ telegram_id: string }>(
    `SELECT telegram_id FROM users WHERE ${where}`,
    params
  );
  return result.rows.map((row) => Number(row.telegram_id));
}

export interface Broadcast {
  id: number;
  body: string;
  segment: string;
  status: string;
  createdBy: number;
  createdAt: Date;
  approvedBy: number | null;
  approvedAt: Date | null;
  sentAt: Date | null;
  sentCount: number;
  failedCount: number;
}

interface BroadcastRow {
  id: number;
  body: string;
  segment: string;
  status: string;
  created_by: string;
  created_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  sent_at: Date | null;
  sent_count: number;
  failed_count: number;
}

function mapBroadcastRow(row: BroadcastRow): Broadcast {
  return {
    id: row.id,
    body: row.body,
    segment: row.segment,
    status: row.status,
    createdBy: Number(row.created_by),
    createdAt: row.created_at,
    approvedBy: row.approved_by !== null ? Number(row.approved_by) : null,
    approvedAt: row.approved_at,
    sentAt: row.sent_at,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
  };
}

export async function createBroadcast(
  pool: Pool,
  body: string,
  segment: string,
  createdBy: number
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO broadcasts (body, segment, status, created_by) VALUES ($1, $2, 'draft', $3) RETURNING id`,
    [body, segment, createdBy]
  );
  return result.rows[0].id;
}

export async function getBroadcast(pool: Pool, id: number): Promise<Broadcast | null> {
  const result = await pool.query<BroadcastRow>('SELECT * FROM broadcasts WHERE id = $1', [id]);
  if (result.rowCount === 0) {
    return null;
  }
  return mapBroadcastRow(result.rows[0]);
}

export async function setBroadcastApproved(
  pool: Pool,
  id: number,
  approvedBy: number
): Promise<void> {
  await pool.query(
    `UPDATE broadcasts SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
    [id, approvedBy]
  );
}

export async function setBroadcastStatus(pool: Pool, id: number, status: string): Promise<void> {
  await pool.query(`UPDATE broadcasts SET status = $2 WHERE id = $1`, [id, status]);
}

export async function completeBroadcast(
  pool: Pool,
  id: number,
  sentCount: number,
  failedCount: number
): Promise<void> {
  await pool.query(
    `UPDATE broadcasts SET status = 'sent', sent_at = now(), sent_count = $2, failed_count = $3 WHERE id = $1`,
    [id, sentCount, failedCount]
  );
}

export type SendStatus = 'sent' | 'failed' | 'blocked';

export interface InsertSendParams {
  broadcastId?: number;
  campaignKey?: string;
  telegramId: number;
  status: SendStatus;
  error?: string;
}

const UNIQUE_VIOLATION = '23505';

export async function insertSend(pool: Pool, params: InsertSendParams): Promise<boolean> {
  try {
    await pool.query(
      `INSERT INTO sends (broadcast_id, campaign_key, telegram_id, status, error)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        params.broadcastId ?? null,
        params.campaignKey ?? null,
        params.telegramId,
        params.status,
        params.error ?? null,
      ]
    );
    return true;
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === UNIQUE_VIOLATION) {
      return false;
    }
    throw err;
  }
}

export interface Stats {
  total: number;
  clicked: number;
  notClicked: number;
  blocked: number;
  sendsLast7Days: number;
}

export async function getStats(pool: Pool): Promise<Stats> {
  const usersResult = await pool.query<{
    total: number;
    clicked: number;
    not_clicked: number;
    blocked: number;
  }>(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE group_clicked = true)::int AS clicked,
      count(*) FILTER (WHERE group_clicked = false)::int AS not_clicked,
      count(*) FILTER (WHERE blocked = true)::int AS blocked
    FROM users
  `);
  const sendsResult = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM sends WHERE sent_at >= now() - interval '7 days'`
  );

  return {
    total: usersResult.rows[0].total,
    clicked: usersResult.rows[0].clicked,
    notClicked: usersResult.rows[0].not_clicked,
    blocked: usersResult.rows[0].blocked,
    sendsLast7Days: sendsResult.rows[0].count,
  };
}

export async function scheduleBackupLink(pool: Pool, telegramId: number): Promise<void> {
  await pool.query(
    `UPDATE users SET scheduled_send_at = now() + interval '1 minute'
     WHERE telegram_id = $1 AND scheduled_send_at IS NULL AND backup_link_sent = false`,
    [telegramId]
  );
}

export async function getBackupLinkEligibleUserIds(pool: Pool): Promise<number[]> {
  const result = await pool.query<{ telegram_id: string }>(
    `SELECT telegram_id FROM users
     WHERE backup_link_sent = false AND blocked = false
       AND scheduled_send_at IS NOT NULL AND scheduled_send_at <= now()`
  );
  return result.rows.map((row) => Number(row.telegram_id));
}

export async function markBackupLinkSent(pool: Pool, telegramId: number): Promise<void> {
  await pool.query(
    `UPDATE users SET backup_link_sent = true, backup_link_sent_at = now() WHERE telegram_id = $1`,
    [telegramId]
  );
}

export interface ChannelPost {
  id: number;
  body: string;
  status: string;
  createdBy: number;
  createdAt: Date;
  approvedBy: number | null;
  approvedAt: Date | null;
  postedAt: Date | null;
  messageId: number | null;
}

interface ChannelPostRow {
  id: number;
  body: string;
  status: string;
  created_by: string;
  created_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  posted_at: Date | null;
  message_id: string | null;
}

function mapChannelPostRow(row: ChannelPostRow): ChannelPost {
  return {
    id: row.id,
    body: row.body,
    status: row.status,
    createdBy: Number(row.created_by),
    createdAt: row.created_at,
    approvedBy: row.approved_by !== null ? Number(row.approved_by) : null,
    approvedAt: row.approved_at,
    postedAt: row.posted_at,
    messageId: row.message_id !== null ? Number(row.message_id) : null,
  };
}

export async function createChannelPost(
  pool: Pool,
  body: string,
  createdBy: number
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO channel_posts (body, status, created_by) VALUES ($1, 'draft', $2) RETURNING id`,
    [body, createdBy]
  );
  return result.rows[0].id;
}

export async function getChannelPost(pool: Pool, id: number): Promise<ChannelPost | null> {
  const result = await pool.query<ChannelPostRow>('SELECT * FROM channel_posts WHERE id = $1', [id]);
  if (result.rowCount === 0) {
    return null;
  }
  return mapChannelPostRow(result.rows[0]);
}

export async function setChannelPostApproved(
  pool: Pool,
  id: number,
  approvedBy: number
): Promise<void> {
  await pool.query(
    `UPDATE channel_posts SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
    [id, approvedBy]
  );
}

export async function setChannelPostStatus(pool: Pool, id: number, status: string): Promise<void> {
  await pool.query(`UPDATE channel_posts SET status = $2 WHERE id = $1`, [id, status]);
}

export async function completeChannelPost(
  pool: Pool,
  id: number,
  messageId: number
): Promise<void> {
  await pool.query(
    `UPDATE channel_posts SET status = 'posted', posted_at = now(), message_id = $2 WHERE id = $1`,
    [id, messageId]
  );
}

export async function listRecentChannelPosts(pool: Pool, limit: number): Promise<ChannelPost[]> {
  const result = await pool.query<ChannelPostRow>(
    'SELECT * FROM channel_posts ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return result.rows.map(mapChannelPostRow);
}

export async function logIncomingMessage(pool: Pool, telegramId: number): Promise<void> {
  await pool.query(`INSERT INTO incoming_messages (telegram_id) VALUES ($1)`, [telegramId]);
}

export type SequenceStep = 1 | 2 | 3;

const STEP_COLUMNS: Record<SequenceStep, { status: string; scheduledAt: string; sentAt: string }> = {
  1: { status: 'step1_status', scheduledAt: 'step1_scheduled_at', sentAt: 'step1_sent_at' },
  2: { status: 'step2_status', scheduledAt: 'step2_scheduled_at', sentAt: 'step2_sent_at' },
  3: { status: 'step3_status', scheduledAt: 'step3_scheduled_at', sentAt: 'step3_sent_at' },
};

const CLAIM_LEASE = "interval '2 minutes'";

// Starts the sequence only for a user who has never had one. Returns false when a
// sequence is already in progress or finished, which makes /start idempotent.
export async function startSequence(pool: Pool, telegramId: number): Promise<boolean> {
  const result = await pool.query(
    `UPDATE users SET
       step1_status = 'pending', step1_scheduled_at = now(),
       step2_status = 'pending', step3_status = 'pending',
       seq_attempts = 0, seq_claimed_at = NULL
     WHERE telegram_id = $1 AND step1_status IS NULL
     RETURNING telegram_id`,
    [telegramId]
  );
  return result.rows.length > 0;
}

export interface DueSequenceStep {
  telegramId: number;
  step: SequenceStep;
}

export async function getDueSequenceSteps(pool: Pool): Promise<DueSequenceStep[]> {
  const unclaimed = `(seq_claimed_at IS NULL OR seq_claimed_at < now() - ${CLAIM_LEASE})`;
  const result = await pool.query<{ telegram_id: string; step: number }>(
    `SELECT telegram_id, step FROM (
       SELECT telegram_id, 1 AS step, step1_scheduled_at AS due_at FROM users
       WHERE blocked = false AND ${unclaimed}
         AND step1_status = 'pending' AND step1_scheduled_at <= now()
       UNION ALL
       SELECT telegram_id, 2, step2_scheduled_at FROM users
       WHERE blocked = false AND ${unclaimed} AND step1_status = 'sent'
         AND step2_status = 'pending' AND step2_scheduled_at <= now()
       UNION ALL
       SELECT telegram_id, 3, step3_scheduled_at FROM users
       WHERE blocked = false AND ${unclaimed} AND step2_status = 'sent'
         AND step3_status = 'pending' AND step3_scheduled_at <= now()
     ) due
     ORDER BY due_at`
  );
  return result.rows.map((row) => ({
    telegramId: Number(row.telegram_id),
    step: Number(row.step) as SequenceStep,
  }));
}

// Takes a short lease on the user's sequence so the /start handler and the cron
// tick (or two overlapping instances during a redeploy) never send the same step twice.
export async function claimSequenceStep(
  pool: Pool,
  telegramId: number,
  step: SequenceStep
): Promise<boolean> {
  const col = STEP_COLUMNS[step];
  const result = await pool.query(
    `UPDATE users SET seq_claimed_at = now()
     WHERE telegram_id = $1 AND blocked = false AND ${col.status} = 'pending'
       AND (seq_claimed_at IS NULL OR seq_claimed_at < now() - ${CLAIM_LEASE})
     RETURNING telegram_id`,
    [telegramId]
  );
  return result.rows.length > 0;
}

// Marks a step sent and schedules the next one from the actual send time.
export async function recordSequenceStepSent(
  pool: Pool,
  telegramId: number,
  step: SequenceStep,
  nextDelaySeconds: number | null
): Promise<void> {
  const col = STEP_COLUMNS[step];
  const next = step < 3 ? STEP_COLUMNS[(step + 1) as SequenceStep] : null;
  const scheduleNext =
    next && nextDelaySeconds !== null
      ? `, ${next.scheduledAt} = now() + ($2::int * interval '1 second')`
      : '';
  await pool.query(
    `UPDATE users SET ${col.status} = 'sent', ${col.sentAt} = now(),
       seq_attempts = 0, seq_claimed_at = NULL${scheduleNext}
     WHERE telegram_id = $1`,
    scheduleNext ? [telegramId, nextDelaySeconds] : [telegramId]
  );
}

export async function recordSequenceStepBlocked(
  pool: Pool,
  telegramId: number,
  step: SequenceStep
): Promise<void> {
  const col = STEP_COLUMNS[step];
  await pool.query(
    `UPDATE users SET ${col.status} = 'blocked', seq_claimed_at = NULL,
       blocked = true, blocked_at = COALESCE(blocked_at, now())
     WHERE telegram_id = $1`,
    [telegramId]
  );
}

// A failed send is retried after retryDelaySeconds until maxAttempts, then the
// step is marked failed and the sequence stops for that user. Returns the new status.
export async function recordSequenceStepFailure(
  pool: Pool,
  telegramId: number,
  step: SequenceStep,
  maxAttempts: number,
  retryDelaySeconds: number
): Promise<'pending' | 'failed'> {
  const col = STEP_COLUMNS[step];
  const result = await pool.query<{ status: string }>(
    `UPDATE users SET
       seq_attempts = seq_attempts + 1,
       seq_claimed_at = NULL,
       ${col.status} = CASE WHEN seq_attempts + 1 >= $2 THEN 'failed' ELSE 'pending' END,
       ${col.scheduledAt} = now() + ($3::int * interval '1 second')
     WHERE telegram_id = $1
     RETURNING ${col.status} AS status`,
    [telegramId, maxAttempts, retryDelaySeconds]
  );
  return result.rows[0]?.status === 'failed' ? 'failed' : 'pending';
}
