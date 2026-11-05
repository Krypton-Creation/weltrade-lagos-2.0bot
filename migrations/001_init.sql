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
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now()
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
  campaign_key TEXT,                   -- for drip sends, e.g. 'drip_day3'
  telegram_id  BIGINT NOT NULL,
  status       TEXT NOT NULL,          -- sent | failed | blocked
  error        TEXT,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sends_broadcast_user ON sends(broadcast_id, telegram_id)
  WHERE broadcast_id IS NOT NULL;
CREATE UNIQUE INDEX sends_campaign_user ON sends(campaign_key, telegram_id)
  WHERE campaign_key IS NOT NULL;
