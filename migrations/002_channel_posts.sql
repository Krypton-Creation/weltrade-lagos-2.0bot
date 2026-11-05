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
