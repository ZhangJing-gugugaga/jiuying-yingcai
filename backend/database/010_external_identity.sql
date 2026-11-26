CREATE TABLE identity_bindings(provider TEXT NOT NULL, external_hash TEXT NOT NULL, actor TEXT NOT NULL REFERENCES users(actor), binding_version INTEGER NOT NULL, encrypted_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(provider,external_hash), UNIQUE(provider,actor));
CREATE TABLE sms_challenges(id TEXT PRIMARY KEY, phone_hash TEXT NOT NULL, actor TEXT REFERENCES users(actor), binding_version INTEGER, code_hash TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE INDEX sms_phone_created ON sms_challenges(phone_hash,created_at);
CREATE TABLE authentication_resets(actor TEXT PRIMARY KEY REFERENCES users(actor), applied_version INTEGER NOT NULL);
