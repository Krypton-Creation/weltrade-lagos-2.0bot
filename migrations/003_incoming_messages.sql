-- incoming_messages: DMs received from non-admin users, for volume tracking
CREATE TABLE incoming_messages (
  id           SERIAL PRIMARY KEY,
  telegram_id  BIGINT NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
