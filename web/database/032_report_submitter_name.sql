ALTER TABLE approval_events ADD COLUMN submitter_name TEXT
  CHECK (submitter_name IS NULL OR (
    collection = 'reports' AND action = 'report.submit' AND length(trim(submitter_name)) > 0
  ));
