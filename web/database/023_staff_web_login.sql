ALTER TABLE sms_challenges ADD COLUMN purpose TEXT NOT NULL DEFAULT 'partner_login'
  CHECK(purpose IN ('partner_login', 'staff_login'));

CREATE TABLE staff_login_mobiles (
  actor TEXT PRIMARY KEY REFERENCES users(actor),
  phone_hash TEXT NOT NULL UNIQUE,
  phone_masked TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE staff_wechat_challenges (
  state_hash TEXT PRIMARY KEY,
  claim_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  actor TEXT REFERENCES users(actor),
  binding_version INTEGER,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  code_hash TEXT UNIQUE,
  CHECK((actor IS NULL AND binding_version IS NULL) OR (actor IS NOT NULL AND binding_version IS NOT NULL))
);

CREATE INDEX staff_wechat_challenges_expiry ON staff_wechat_challenges(expires_at);
