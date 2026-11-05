# Weltrade Lagos Synthetic Trading Summit 2.0 Telegram Bot

A Telegram gateway bot for the Weltrade Lagos Synthetic Trading Summit 2.0 community.
It captures a permanent DM channel with every registrant and, after /start, sends three
messages in order: a welcome with the Telegram group link, the Eventbrite registration
link, and the WhatsApp group link. It also lets the Weltrade team send approved
broadcasts and timed reminders to segments of those members.

Event details (name, date, time, venue) and every link come from environment
variables, so a future event only needs env changes.

There is no AI in this build. It is a deterministic bot.

See `CLAUDE.md` for the product spec and `ARCHITECTURE.md` for the full technical
specification (schema, segments, rate limits, admin flow).

## Requirements

- Node.js 18 or later
- A PostgreSQL database
- A Telegram bot token from BotFather

## Setup

1. Install dependencies:

   ```
   npm install
   ```

2. Copy the environment template and fill in real values:

   ```
   cp .env.example .env
   ```

   Required:

   - `BOT_TOKEN` - Telegram bot token from BotFather
   - `DATABASE_URL` - Postgres connection string
   - `ADMIN_CHAT_ID` - Telegram chat id where broadcasts are drafted and approved
   - `ADMIN_USER_IDS` - comma separated Telegram user ids allowed to draft or approve
   - `CHANNEL_ID` - the Telegram channel id or @username channel posts are sent to
     (set `unused` if there is no channel)
   - `EVENT_NAME` - for example `Weltrade Lagos Synthetic Trading Summit 2.0`
   - `EVENT_DATE_ISO` - event date as `YYYY-MM-DD`
   - `EVENT_TIME_LABEL` - for example `9:00 AM prompt`
   - `EVENT_VENUE` - venue line shown in the welcome message
   - `GROUP_URL` - Telegram group link
   - `EVENTBRITE_URL` - Eventbrite registration link
   - `WHATSAPP_GROUP_URL` - WhatsApp group link

   Optional:

   - `STEP2_DELAY_SECONDS` - seconds between Message 1 and Message 2, default 60
   - `STEP3_DELAY_SECONDS` - seconds between Message 2 and Message 3, default 60
   - `BACKUP_GROUP_URL` - turns on the backup group message 1 minute after /start.
     Leave unset unless there is a separate backup group.

   The bot exits at startup with a list of problems if any required value is missing,
   malformed, or still a placeholder from `.env.example`.

3. Build:

   ```
   npm run build
   ```

4. Run:

   ```
   npm start
   ```

   Pending SQL migrations in `migrations/` are applied automatically on startup,
   before the bot begins polling.

## Admin usage

All admin commands only work inside the chat identified by `ADMIN_CHAT_ID`, from a
user id listed in `ADMIN_USER_IDS`. Anyone else invoking them gets no response.

- `/broadcast <segment>` - draft a broadcast. Either reply to an existing message with
  this command, or send it alone and then send the message body as your next message.
  Segments: `all`, `not_clicked`, `clicked`, `tag:<name>`.
- `/post` - draft a channel post. Either reply to an existing message with this
  command, or send it alone and then send the message body as your next message.
  Posts to `CHANNEL_ID`, no segment.
- `/posts` - list the 10 most recent channel posts, newest first.
- `/stats` - total users, clicked, not clicked, blocked, sends in the last 7 days.
- `/tag <telegram_id> <tag>` - add a tag to a user.
- `/untag <telegram_id> <tag>` - remove a tag from a user.
- `/cancel <broadcast_id>` - cancel a draft or approved broadcast before it sends.

Both broadcast and channel post previews carry an "Approve and send" and a "Cancel"
button. If more than one admin id is configured, approval must come from a different
admin than the one who drafted it. With a single admin configured, self approval is
allowed.

## Deploying on Railway

1. Create a new Railway project and add a PostgreSQL plugin.
2. Create a service from this repository.
3. Set the environment variables listed above in the service settings. Use the
   `DATABASE_URL` Railway provides for the Postgres plugin.
4. Set the start command to `npm run build && npm start`, or configure a build step
   that runs `npm run build` and a start step that runs `npm start`.
5. Deploy. The bot uses long polling, so it needs to run as a long lived process, not
   a serverless function. On startup it applies any pending migrations from
   `migrations/` before it starts polling and before the cron jobs are scheduled.

## Project structure

```
src/
  bot/       Telegram layer: bot wiring, /start flow, the shared sender
  db/        Database pool usage, migration runner, all SQL queries
  jobs/      The /start sequence (15 second tick) and the optional backup link
  admin/     Admin auth, the /broadcast and /post flows, admin commands
migrations/  Plain SQL migration files, applied in order on startup
```
