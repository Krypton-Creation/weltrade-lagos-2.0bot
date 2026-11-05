# ARCHITECTURE.md

Technical specification for the Weltrade Lagos Synthetic Trading Summit 2.0 Telegram
support handle. Event name, date, time, venue and all links come from environment
variables (see `CLAUDE.md`), so nothing event specific is hard coded.

## 1. Platform constraints that shape everything

- A bot CANNOT message a user who has never pressed /start on it. There is no
  workaround. Every reachable user must pass through the bot first.
- Users can block the bot at any time. A 403 on send means blocked. Mark them and
  stop sending. Never retry a blocked user.
- Telegram rate limits bulk sending. Target 20 messages per second maximum across
  the whole bot. On HTTP 429, read `retry_after` from the response and wait exactly
  that long before resuming. Never ignore it.
- Telegram gives us `telegram_id`, `first_name`, `last_name` and `username` only.
  No email, no phone. Segments can only be built from in-Telegram behaviour.

## 2. Database schema

```sql
-- users: everyone who has pressed /start
CREATE TABLE users (
  telegram_id    BIGINT PRIMARY KEY,
  first_name     TEXT,
  last_name      TEXT,
  username       TEXT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  group_clicked  BOOLEAN NOT NULL DEFAULT false,
  group_clicked_at TIMESTAMPTZ,
  blocked        BOOLEAN NOT NULL DEFAULT false,
  blocked_at     TIMESTAMPTZ,
  tags           TEXT[] NOT NULL DEFAULT '{}',
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  backup_link_sent    BOOLEAN NOT NULL DEFAULT false,
  backup_link_sent_at TIMESTAMPTZ,
  scheduled_send_at   TIMESTAMPTZ,
  -- /start sequence (migration 006). Status: NULL before /start, then
  -- pending | sent | failed | blocked.
  step1_status       TEXT,
  step1_scheduled_at TIMESTAMPTZ,
  step1_sent_at      TIMESTAMPTZ,
  step2_status       TEXT,
  step2_scheduled_at TIMESTAMPTZ,
  step2_sent_at      TIMESTAMPTZ,
  step3_status       TEXT,
  step3_scheduled_at TIMESTAMPTZ,
  step3_sent_at      TIMESTAMPTZ,
  seq_attempts       INT NOT NULL DEFAULT 0,
  seq_claimed_at     TIMESTAMPTZ
);

-- broadcasts: admin drafted messages awaiting or past approval
CREATE TABLE broadcasts (
  id           SERIAL PRIMARY KEY,
  body         TEXT NOT NULL,
  segment      TEXT NOT NULL,          -- see section 4
  status       TEXT NOT NULL,          -- draft | approved | sending | sent | cancelled
  created_by   BIGINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by  BIGINT,
  approved_at  TIMESTAMPTZ,
  sent_at      TIMESTAMPTZ,
  sent_count   INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0
);

-- sends: one row per delivery attempt. Prevents duplicates, enables resume.
CREATE TABLE sends (
  id           SERIAL PRIMARY KEY,
  broadcast_id INT REFERENCES broadcasts(id),
  campaign_key TEXT,                   -- for sequence sends, e.g. 'lagos2_step1'
  telegram_id  BIGINT NOT NULL,
  status       TEXT NOT NULL,          -- sent | failed | blocked
  error        TEXT,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sends_broadcast_user ON sends(broadcast_id, telegram_id)
  WHERE broadcast_id IS NOT NULL;
CREATE UNIQUE INDEX sends_campaign_user ON sends(campaign_key, telegram_id)
  WHERE campaign_key IS NOT NULL;

-- channel_posts: admin drafted posts to the public channel
CREATE TABLE channel_posts (
  id           SERIAL PRIMARY KEY,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL,          -- draft | approved | cancelled | posted
  created_by   BIGINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by  BIGINT,
  approved_at  TIMESTAMPTZ,
  posted_at    TIMESTAMPTZ,
  message_id   BIGINT
);
```

The two unique indexes are the safety net. They make it impossible to send the same
broadcast to the same person twice, and they keep one `sends` log row per user per
campaign step, even if a job crashes and reruns.

## 3. The /start flow

Never call this thing a "bot" in any user-facing copy, message, or button, in this
flow or in anything added later. Where a self-reference is needed, call it the
"support handle" instead. This rule applies project-wide and must survive future
rebuilds and future cities.

1. Upsert the user into `users` (update `last_seen_at` on every interaction).
   `started_at` is set on first contact.
2. Claim the sequence: `UPDATE users SET step1/2/3_status = 'pending',
   step1_scheduled_at = now() WHERE telegram_id = $1 AND step1_status IS NULL`.
   If no row is updated, the user already has a sequence (in progress or finished):
   reply once with a short message carrying all three links as URL buttons, and stop.
   A repeat /start never resends or restarts the sequence.
3. Send Message 1 straight away from the /start handler.
4. Message 2 and Message 3 are sent by the 15 second cron tick (section 3b).

/start is only handled in private chats.

The three messages, each with a single URL button:

| Step | When | Button | Link |
| --- | --- | --- | --- |
| 1 | Immediately | Join our Telegram group | `GROUP_URL` |
| 2 | `STEP2_DELAY_SECONDS` after step 1 was actually sent | Register on Eventbrite | `EVENTBRITE_URL` |
| 3 | `STEP3_DELAY_SECONDS` after step 2 was actually sent | Join the WhatsApp group | `WHATSAPP_GROUP_URL` |

The sequence is time based. Nothing waits for a button tap. Because these are URL
buttons, taps are not tracked, so nothing sets `group_clicked` any more (see
section 4).

The copy lives in `src/jobs/sequence.ts`. The date lines in Message 1 ("Date:
November 28, 2026" and "Save the date: November 28th") are built from
`EVENT_DATE_ISO`, the venue line from `EVENT_VENUE` and the time line from
`EVENT_TIME_LABEL`. The three label emojis on those lines are the only emojis allowed
in bot copy.

## 3b. Sequence scheduler (15 second tick)

Same pattern as the backup link below: the send time lives in Postgres, never in an
in-memory timer, so restarts and redeploys lose nothing.

- When step N is sent, one UPDATE sets `stepN_status = 'sent'`, `stepN_sent_at = now()`
  and `step(N+1)_scheduled_at = now() + delay`. Step 2 is timed from the real step 1
  send, and step 3 from the real step 2 send.
- A cron job runs every 15 seconds (and once at startup). Each tick selects users
  where the previous step is `sent`, this step is `pending`, `scheduled_at <= now()`
  and `blocked = false`, and sends through the shared throttled sender. With the
  15 second tick, a step lands between 0 and 15 seconds after it is due.
- Before sending, a 2 minute lease (`seq_claimed_at`) is taken with a conditional
  UPDATE. The /start handler and the tick, or two instances overlapping during a
  redeploy, can never send the same step twice.
- Blocked (403 "bot was blocked by the user"): the step is marked `blocked`,
  `users.blocked` is set, and the rest of the sequence stops. No error is raised.
- Any other failure: the step stays `pending` and is retried 60 seconds later, up to
  3 attempts in total, then it is marked `failed` and the sequence stops.
- Each send logs one line: `Sequence send telegram_id=... step=N ok` or `error=...`.
- Each attempt also writes a `sends` row with `campaign_key = lagos2_stepN`.

## 3c. Backup channel message (optional)

Off unless `BACKUP_GROUP_URL` is set. Message 3 of the sequence already sends the
WhatsApp group, so only turn this on for a separate backup group.

When it is on, /start sets `scheduled_send_at = now() + interval '1 minute'` on the
user's row (only if it is not already set and the backup link has not already gone
out), and a separate 15 second cron job sends the backup message to users where
`backup_link_sent = false AND blocked = false AND scheduled_send_at <= now()`. It sets
`backup_link_sent = true` after each send that succeeds or finds the user blocked. A
`failed` outcome leaves the flag unset so the next tick retries it. An in-process
guard skips a tick if the previous one is still running.

The send verifies the `chat.id` on Telegram's response matches the `telegram_id` it was
called with; a mismatch is treated as a failure.

Migration `004_backup_link.sql` backfilled every user that existed before this feature
shipped to `backup_link_sent = true`, so it never fires retroactively.

Backup message copy:

> This is important. Please join both.
>
> The Telegram group above is our main channel, but platforms occasionally have issues
> outside our control, and we have seen it happen before. The WhatsApp group below is
> our backup, so if anything ever affects Telegram, you do not miss event updates,
> reminders, or your seat confirmation.
>
> Join it now, it takes ten seconds:
>
> {BACKUP_GROUP_URL}
>
> Both groups take less than a minute combined. Do not skip this one.

## 4. Segments

Segments are resolved at send time by SQL. Available segments:

- `all` - every user where `blocked = false`
- `not_clicked` - `group_clicked = false AND blocked = false`
- `clicked` - `group_clicked = true AND blocked = false`
- `tag:<name>` - users whose `tags` array contains `<name>`

Nothing sets `group_clicked` in this build (the /start buttons are URL buttons, which
Telegram does not report taps for). So `not_clicked` matches the same users as `all`,
and `clicked` matches nobody. The segments are kept so the admin commands stay as they
were.

## 5. Admin broadcast flow (human in the loop)

All of this happens inside the Telegram chat identified by `ADMIN_CHAT_ID`.
Only user IDs in `ADMIN_USER_IDS` may draft or approve.

1. Admin sends `/broadcast <segment>` then the message body, or replies to a message
   with `/broadcast <segment>`.
2. Bot creates a `broadcasts` row with `status = draft` and posts a preview back into
   the admin chat, showing: the exact message, the segment, and the recipient count.
3. The preview carries two inline buttons: "Approve and send" and "Cancel".
4. Approval must come from a DIFFERENT admin user id than the creator where more than
   one admin exists. If only one admin is configured, allow self approval.
5. On approval: set `status = approved`, then hand to the sender.
6. The sender processes the segment at a maximum of 20 messages per second, writing a
   `sends` row per recipient, and posts a completion summary back to the admin chat
   with sent and failed counts.

## 5b. Admin channel post flow (human in the loop)

All of this happens inside the Telegram chat identified by `ADMIN_CHAT_ID`.
Only user IDs in `ADMIN_USER_IDS` may draft or approve. Unlike a broadcast, a channel
post has one fixed destination, `CHANNEL_ID`, so there is no segment to choose.

1. Admin sends `/post` then the message body, or replies to a message with `/post`.
2. Bot creates a `channel_posts` row with `status = draft` and posts a preview back
   into the admin chat, showing the exact message.
3. The preview carries two inline buttons: "Approve and send" and "Cancel".
4. Approval must come from a DIFFERENT admin user id than the creator where more than
   one admin exists. If only one admin is configured, allow self approval.
5. On approval: set `status = approved`, then send the message to `CHANNEL_ID`. On
   success, store the returned `message_id` and set `status = posted`.
6. `/posts` lists the 10 most recent `channel_posts` rows, newest first, with id,
   status and a body snippet.

## 6. The sender (shared by broadcasts and the /start sequence)

One module. Broadcasts, the backup link and the /start sequence all go through it. The sequence uses `sendOne`, which returns the real delivery status and treats the
`sends` row as a log only.

- Throttle to 20 messages per second.
- On 429: read `retry_after`, sleep that many seconds, retry the same user once.
- On 403 (bot blocked): set `users.blocked = true`, `blocked_at = now()`, write a
  `sends` row with status `blocked`, and continue. Do not retry.
- On any other error: write a `sends` row with status `failed` and the error text,
  and continue. One bad recipient must never stop a run.
- Resume safety: before sending to a user, the unique index on `sends` prevents a
  duplicate. Catch the constraint violation and skip rather than crashing.

## 7. Admin commands

- `/broadcast <segment>` - draft a broadcast
- `/post` - draft a channel post
- `/posts` - list the 10 most recent channel posts
- `/stats` - total users, clicked, not clicked, blocked, sends in the last 7 days
- `/tag <telegram_id> <tag>` - add a tag to a user
- `/untag <telegram_id> <tag>` - remove a tag
- `/cancel <broadcast_id>` - cancel a draft or approved broadcast before it sends

Non admins invoking these get no response at all. Do not reply with an error, it just
tells people the commands exist.

## 8. Deployment

Railway. Long running process, not serverless, because the bot holds a polling
connection and runs cron. Use grammY long polling for now. Webhooks can come later if
volume demands it.
