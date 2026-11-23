-- Expand only. Original report values and ownership are preserved.
CREATE TABLE contentVersions (id TEXT PRIMARY KEY, owner TEXT, outlet TEXT, status TEXT NOT NULL, month TEXT, version INTEGER, current INTEGER NOT NULL DEFAULT 0, amount_cents INTEGER, data TEXT NOT NULL CHECK(json_valid(data)), created_at TEXT NOT NULL);
CREATE INDEX idx_contentVersions_content ON contentVersions(json_extract(data,'$.contentId'),version);
-- Approved outlet applications previously defaulted an unknown enrollment rule to false.
-- Only application-created outlets without a recorded confirmation are corrected.
UPDATE outlets SET data=json_set(data,'$.enrollmentApplicable',NULL,'$.enrollmentStatus','pending','$.enrollmentHistory',json('[]'))
WHERE json_type(data,'$.enrollmentHistory') IS NULL AND id IN (
 SELECT json_extract(data,'$.data.createdOutletId') FROM requests
 WHERE status='approved' AND json_extract(data,'$.type')='newOutlet'
);
