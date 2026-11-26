-- Preserve original and reversed bills while enforcing one collectible bill per outlet/month.
-- Existing 001 uniqueness guarantees this partial index can be created without data rewriting.
-- SQLite rebuilds the index transactionally; schedule a maintenance window for large bill tables.
-- Application rollback retains this compatible index. Do not re-create the old full index after
-- corrections have been recorded: that would conflict with legitimate preserved history.
DROP INDEX bill_period_unique;
CREATE UNIQUE INDEX bill_period_unique ON bills(outlet,month) WHERE status <> 'reversed';
