-- backup link: WhatsApp backup group message sent 3 minutes after /start
ALTER TABLE users
  ADD COLUMN backup_link_sent BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN backup_link_sent_at TIMESTAMPTZ;

-- Existing users should not receive this retroactively, only new /start events.
UPDATE users SET backup_link_sent = true WHERE backup_link_sent = false;
