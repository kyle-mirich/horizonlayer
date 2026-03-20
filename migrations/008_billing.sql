CREATE TABLE IF NOT EXISTS subscriptions (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan_name              VARCHAR(64) NOT NULL DEFAULT 'solo',
  status                 VARCHAR(32) NOT NULL DEFAULT 'inactive',
  stripe_customer_id     TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  current_period_end     TIMESTAMPTZ,
  cancel_at_period_end   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT subscriptions_status_check CHECK (
    status IN ('inactive', 'trialing', 'active', 'past_due', 'canceled', 'unpaid')
  )
);

CREATE TABLE IF NOT EXISTS billing_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type      VARCHAR(128) NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS subscriptions_status_idx
  ON subscriptions(status, current_period_end);
