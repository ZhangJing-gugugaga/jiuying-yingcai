ALTER TABLE onboarding_files ADD COLUMN target_application_id TEXT REFERENCES onboarding_applications(id);
ALTER TABLE onboarding_files ADD COLUMN target_application_version INTEGER CHECK (
  (target_application_id IS NULL AND target_application_version IS NULL) OR
  (target_application_id IS NOT NULL AND purpose = 'onboarding-proof'
    AND typeof(target_application_version) = 'integer' AND target_application_version > 0)
);
