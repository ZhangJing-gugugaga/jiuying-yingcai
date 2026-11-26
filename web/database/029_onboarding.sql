CREATE TABLE onboarding_config (
  id INTEGER PRIMARY KEY CHECK (id=1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  qr_file_id TEXT REFERENCES files(id),
  payee TEXT,
  tracking_key BLOB NOT NULL CHECK (length(tracking_key)=32)
);
INSERT INTO onboarding_config(id,tracking_key) VALUES(1,randomblob(32));

CREATE TABLE onboarding_applications (
  id TEXT PRIMARY KEY,
  applicant_subject TEXT NOT NULL,
  name TEXT NOT NULL,
  mobile TEXT NOT NULL,
  organization TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','returned','approved')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version>0),
  qr_file_id TEXT NOT NULL REFERENCES files(id),
  payee TEXT NOT NULL,
  file_id TEXT NOT NULL REFERENCES files(id),
  applicant_note TEXT NOT NULL,
  review_note TEXT,
  reviewed_by TEXT REFERENCES users(actor),
  settlement_reference TEXT UNIQUE,
  account_actor TEXT UNIQUE REFERENCES users(actor),
  submitted_at TEXT NOT NULL,
  reviewed_at TEXT
);
CREATE INDEX onboarding_subject ON onboarding_applications(applicant_subject,submitted_at);
CREATE INDEX onboarding_status ON onboarding_applications(status,submitted_at);
CREATE UNIQUE INDEX onboarding_live_mobile ON onboarding_applications(mobile) WHERE status IN ('pending','approved');

CREATE TABLE onboarding_files (
  file_id TEXT PRIMARY KEY REFERENCES files(id),
  purpose TEXT NOT NULL CHECK (purpose IN ('onboarding-qr','onboarding-proof')),
  application_id TEXT REFERENCES onboarding_applications(id)
);
