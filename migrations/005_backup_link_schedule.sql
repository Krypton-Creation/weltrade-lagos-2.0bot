-- Explicit scheduled_send_at for the backup link message, set once at /start time.
-- Delivery is driven entirely by this stored timestamp, read fresh by cron on every
-- tick, so it survives process restarts by design (no in-memory timer involved).
ALTER TABLE users ADD COLUMN scheduled_send_at TIMESTAMPTZ;
