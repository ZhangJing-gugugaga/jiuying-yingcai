-- 002: forward repair of derived amount index only. JSON source and genuine numeric zero remain unchanged.
-- Applies only to records whose source amount is missing or JSON null; safe to repeat.
UPDATE outlets SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;
UPDATE reports SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;
UPDATE requests SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;
UPDATE bills SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;
UPDATE payments SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;
UPDATE receipts SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;
UPDATE adjustments SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;
UPDATE verifications SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;
UPDATE exemptions SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;
UPDATE messages SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;
UPDATE audit SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;
UPDATE accounts SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;
UPDATE settlements SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;
UPDATE drafts SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;
UPDATE summaryAdjustments SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;
UPDATE supportChats SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;
UPDATE supportTickets SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;
UPDATE contents SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;
UPDATE organizations SET amount_cents=NULL WHERE amount_cents IS NOT NULL AND json_extract(data,'$.amount') IS NULL;

