CREATE TABLE approval_export_grants (
  staff_id TEXT NOT NULL REFERENCES users(actor),
  outlet TEXT NOT NULL REFERENCES outlets(id),
  category TEXT NOT NULL CHECK(category IN ('reports','requests','verifications')),
  staff_role TEXT NOT NULL CHECK(staff_role IN ('ops','finance','regional','location')),
  fields TEXT NOT NULL CHECK(json_valid(fields) AND json_type(fields) = 'array'),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  updated_by TEXT NOT NULL REFERENCES users(actor),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(staff_id, outlet, category)
);

CREATE TRIGGER approval_export_revoke_on_staff_change
AFTER UPDATE OF role, status ON users
WHEN OLD.role <> NEW.role OR NEW.status <> 'active'
BEGIN
  UPDATE approval_export_grants SET enabled=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE staff_id=NEW.actor AND enabled=1;
END;
