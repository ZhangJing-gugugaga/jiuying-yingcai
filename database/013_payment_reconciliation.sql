-- Additive migration. Existing orders are picked up by the bounded reconciliation worker.
ALTER TABLE payment_provider_orders ADD COLUMN query_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_provider_orders ADD COLUMN next_query_at TEXT;
ALTER TABLE payment_provider_orders ADD COLUMN last_query_at TEXT;
CREATE INDEX payment_reconciliation_due ON payment_provider_orders(status,next_query_at,query_attempts);
