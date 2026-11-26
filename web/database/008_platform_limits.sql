CREATE TABLE file_metadata(file_id TEXT PRIMARY KEY REFERENCES files(id), original_digest TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, transform_version TEXT NOT NULL);
CREATE INDEX auth_attempts_window ON auth_attempts(window_start);
CREATE INDEX credentials_actor_username ON credentials(actor,username);
CREATE INDEX idx_summary_source_status ON summaryAdjustments(json_extract(data,'$.sourceReportId'),status);
