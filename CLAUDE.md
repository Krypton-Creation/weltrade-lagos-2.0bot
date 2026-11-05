# Weltrade Lagos Synthetic Trading Summit 2.0 Telegram Bot

## What this is
A Telegram gateway bot for the Weltrade Lagos Synthetic Trading Summit 2.0 community. Its job is to capture a
permanent DM channel with every community member, hand them the event links, and let
the Weltrade team send approved broadcasts and timed reminders to segments of those
members.

There is NO AI in this build. No OpenAI, no RAG, no vector store, no LLM calls.
It is a deterministic bot. Do not add an AI layer.

## Why it exists
The previous community channels were suspended twice with no recovery path. A Telegram
bot that users have pressed /start on can be direct messaged permanently, independent
of any group's status. The bot is the durable channel. The group is secondary.

## Core flow
1. User presses /start
2. Message 1, immediately: welcome text with a "Join our Telegram group" URL button
3. Message 2, `STEP2_DELAY_SECONDS` after Message 1 was sent: Eventbrite registration
   with a "Register on Eventbrite" URL button
4. Message 3, `STEP3_DELAY_SECONDS` after Message 2 was sent: WhatsApp group with a
   "Join the WhatsApp group" URL button
5. User is now in the database and permanently reachable by DM
The sequence is time based, not gated on taps. Steps 2 and 3 are stored in Postgres
and sent by the 15 second cron tick, so they survive restarts. A repeat /start never
restarts the sequence; it replies once with all three links.
No details are collected at the gate. Name, email and phone already exist in the
team's lead sheets. Do not ask for them.

## Source of truth
- `ARCHITECTURE.md` in this repo covers the schema, segments, rate limits and admin flow.
  Read it fully before writing code.

## Stack
- Node.js + TypeScript
- grammY for the Telegram layer
- PostgreSQL (node-postgres). No ORM.
- node-cron for scheduled sends
- Deployed on Railway
No other dependencies without a clear reason.

## Hard rules
- No emojis anywhere: code, comments, commit messages, or bot copy. The only exception is
  the three label emojis (date, venue, time) in Message 1 of the /start sequence.
- No em dashes or en dashes anywhere.
- No AI-sounding filler in bot copy. Conversational Nigerian-professional English.
  Direct, specific, make the point and move on.
- All secrets via environment variables. Never hardcode the bot token.
- Every outbound message must be rate limited and logged. No unthrottled loops.

## Environment variables
All required unless marked optional. The bot refuses to start if a required value is
missing or still a placeholder from `.env.example`.
- `BOT_TOKEN` - Telegram bot token
- `DATABASE_URL` - Postgres connection string
- `ADMIN_CHAT_ID` - Telegram chat where broadcasts are drafted and approved
- `ADMIN_USER_IDS` - comma separated Telegram user IDs allowed to approve
- `CHANNEL_ID` - the Telegram channel id or @username for /post (set `unused` if none)
- `EVENT_NAME` - event name used in reminders and the repeat /start reply
- `EVENT_DATE_ISO` - event date as YYYY-MM-DD, drives the date lines in Message 1
- `EVENT_TIME_LABEL` - time line in Message 1, for example "9:00 AM prompt"
- `EVENT_VENUE` - venue line in Message 1
- `GROUP_URL` - Telegram group link (Message 1)
- `EVENTBRITE_URL` - Eventbrite registration link (Message 2)
- `WHATSAPP_GROUP_URL` - WhatsApp group link (Message 3)
- `STEP2_DELAY_SECONDS`, `STEP3_DELAY_SECONDS` - optional, default 60
- `BACKUP_GROUP_URL` - optional. Turns on the old backup group message 1 minute after
  /start. Leave unset unless there is a separate backup group, since Message 3 already
  sends the WhatsApp link.

## Working style
- Small, flat structure: `src/bot/`, `src/db/`, `src/jobs/`, `src/admin/`
- Migrations as plain SQL files in `migrations/`
- `npm run build` must pass with zero TypeScript errors before anything is called done
