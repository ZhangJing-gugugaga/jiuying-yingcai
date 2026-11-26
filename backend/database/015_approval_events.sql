CREATE TABLE approval_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  collection TEXT NOT NULL,
  object_id TEXT NOT NULL,
  audit_record_id TEXT NOT NULL,
  original_entry TEXT,
  action TEXT NOT NULL,
  role TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  UNIQUE (collection, object_id, audit_record_id)
);

CREATE INDEX approval_events_object_order ON approval_events(collection, object_id, occurred_at DESC, seq DESC);
CREATE INDEX approval_events_original_entry ON approval_events(collection, object_id, original_entry) WHERE original_entry IS NOT NULL;
CREATE INDEX approval_legacy_audit_object ON audit(json_extract(data, '$.recordId'), json_extract(data, '$.executedAt'))
  WHERE json_extract(data, '$.recordId') IS NOT NULL;

CREATE TRIGGER approval_events_no_update BEFORE UPDATE ON approval_events
BEGIN
  SELECT RAISE(ABORT, 'approval events are immutable');
END;

CREATE TRIGGER approval_events_no_delete BEFORE DELETE ON approval_events
BEGIN
  SELECT RAISE(ABORT, 'approval events are immutable');
END;

CREATE TRIGGER approval_events_no_replace BEFORE INSERT ON approval_events
WHEN EXISTS (SELECT 1 FROM approval_events WHERE seq = NEW.seq OR id = NEW.id)
  OR EXISTS (SELECT 1 FROM approval_events WHERE collection = NEW.collection AND object_id = NEW.object_id AND audit_record_id = NEW.audit_record_id)
BEGIN
  SELECT RAISE(ABORT, 'approval events are immutable');
END;
