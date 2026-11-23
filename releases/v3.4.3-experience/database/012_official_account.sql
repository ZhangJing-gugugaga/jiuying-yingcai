CREATE TABLE official_contacts(subject TEXT PRIMARY KEY, encrypted_id TEXT NOT NULL, chat_id TEXT REFERENCES supportChats(id), last_inbound_at TEXT NOT NULL);
CREATE TABLE official_inbound(message_id TEXT PRIMARY KEY, body_digest TEXT NOT NULL, response_xml TEXT NOT NULL, received_at TEXT NOT NULL);
CREATE TABLE official_outbox(id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES supportChats(id), subject TEXT NOT NULL REFERENCES official_contacts(subject), content TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX official_outbox_status ON official_outbox(status,created_at);
