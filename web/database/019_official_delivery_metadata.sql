ALTER TABLE official_outbox ADD COLUMN provider_mode TEXT NOT NULL DEFAULT 'wechat' CHECK(provider_mode IN ('wechat','mock'));
ALTER TABLE official_outbox ADD COLUMN provider_code INTEGER;
ALTER TABLE official_outbox ADD COLUMN provider_accepted_at TEXT;
ALTER TABLE official_outbox ADD COLUMN next_attempt_at TEXT;
CREATE INDEX official_outbox_due ON official_outbox(provider_mode,next_attempt_at,created_at) WHERE status='pending';
