-- Three step /start sequence: welcome + Telegram group, Eventbrite, WhatsApp group.
-- Step status is NULL until the user runs /start, then pending | sent | failed | blocked.
-- Each stepN_scheduled_at is set when the previous step is actually sent, and the
-- 15 second cron tick sends anything due, so the sequence survives restarts.
-- seq_claimed_at is a short lease that stops two ticks sending the same step.
ALTER TABLE users
  ADD COLUMN step1_status       TEXT,
  ADD COLUMN step1_scheduled_at TIMESTAMPTZ,
  ADD COLUMN step1_sent_at      TIMESTAMPTZ,
  ADD COLUMN step2_status       TEXT,
  ADD COLUMN step2_scheduled_at TIMESTAMPTZ,
  ADD COLUMN step2_sent_at      TIMESTAMPTZ,
  ADD COLUMN step3_status       TEXT,
  ADD COLUMN step3_scheduled_at TIMESTAMPTZ,
  ADD COLUMN step3_sent_at      TIMESTAMPTZ,
  ADD COLUMN seq_attempts       INT NOT NULL DEFAULT 0,
  ADD COLUMN seq_claimed_at     TIMESTAMPTZ;

CREATE INDEX users_step1_due ON users (step1_scheduled_at) WHERE step1_status = 'pending';
CREATE INDEX users_step2_due ON users (step2_scheduled_at) WHERE step2_status = 'pending';
CREATE INDEX users_step3_due ON users (step3_scheduled_at) WHERE step3_status = 'pending';
