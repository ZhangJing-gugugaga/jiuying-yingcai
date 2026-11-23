CREATE TABLE training_courses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);
CREATE INDEX training_courses_status_updated ON training_courses(status,updated_at DESC,id);

CREATE TABLE training_records (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES training_courses(id),
  outlet_id TEXT NOT NULL REFERENCES outlets(id),
  owner TEXT NOT NULL,
  learner TEXT NOT NULL,
  learner_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('in_progress','submitted','returned','materials_approved','completed')),
  version INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(course_id,outlet_id,owner,learner_key)
);
CREATE INDEX training_records_owner_outlet ON training_records(owner,outlet_id,updated_at DESC,id);
CREATE INDEX training_records_review_queue ON training_records(outlet_id,status,updated_at DESC,id);
CREATE INDEX training_records_updated ON training_records(updated_at DESC,id);

CREATE TABLE training_reviews (
  record_id TEXT NOT NULL REFERENCES training_records(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('returned','materials_approved','completed')),
  note TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(record_id,version)
);

CREATE TABLE training_materials (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES training_records(id),
  revision INTEGER NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL CHECK(mime IN ('image/png','image/jpeg','image/webp')),
  size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 5242880),
  digest TEXT NOT NULL,
  original_digest TEXT NOT NULL,
  transform_version TEXT NOT NULL,
  bytes BLOB NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(record_id,revision)
);

CREATE TABLE training_review_grants (
  subject TEXT NOT NULL REFERENCES staffAccounts(id),
  outlet_id TEXT NOT NULL REFERENCES outlets(id),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(subject,outlet_id)
);
CREATE INDEX training_review_grants_enabled ON training_review_grants(subject,enabled,outlet_id);

CREATE TRIGGER retire_training_review_grants
AFTER UPDATE OF data,status ON staffAccounts
BEGIN
  UPDATE training_review_grants
  SET enabled=0,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE subject=NEW.id AND enabled=1 AND (
    NEW.status<>'active' OR json_extract(NEW.data,'$.role')<>'regional'
    OR NOT EXISTS (
      SELECT 1 FROM json_each(NEW.data,'$.grants.reviewOutlets') decisions
      JOIN json_each(NEW.data,'$.grants.outlets') outlets ON decisions.value=outlets.value
      WHERE decisions.value=training_review_grants.outlet_id
    )
  );
END;
