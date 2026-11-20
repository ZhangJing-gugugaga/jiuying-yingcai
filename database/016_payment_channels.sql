-- The original order/notification rows and the active-bill constraint remain valid.
ALTER TABLE payment_provider_orders ADD COLUMN channel TEXT NOT NULL DEFAULT 'wechat' CHECK(channel IN ('wechat','alipay'));
ALTER TABLE payment_provider_orders ADD COLUMN adapter_mode TEXT NOT NULL DEFAULT 'real' CHECK(adapter_mode IN ('real','mock'));
ALTER TABLE payment_provider_orders ADD COLUMN collection_entity TEXT;
ALTER TABLE payment_provider_orders ADD COLUMN agreement_id TEXT REFERENCES agreements(id);
ALTER TABLE payment_provider_orders ADD COLUMN currency TEXT NOT NULL DEFAULT 'CNY' CHECK(currency='CNY');
CREATE INDEX payment_provider_orders_channel ON payment_provider_orders(channel,adapter_mode,status);

CREATE TABLE payment_refund_orders(
 id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payment_provider_orders(payment_id),
 bill_id TEXT NOT NULL REFERENCES bills(id), receipt_id TEXT NOT NULL REFERENCES receipts(id),
 refund_request_id TEXT REFERENCES refundRequests(id), channel TEXT NOT NULL CHECK(channel IN ('wechat','alipay')),
 adapter_mode TEXT NOT NULL CHECK(adapter_mode IN ('real','mock')),
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0), currency TEXT NOT NULL CHECK(currency='CNY'),
 status TEXT NOT NULL CHECK(status IN ('pending','success','failed')),
 merchant_id TEXT NOT NULL, app_id TEXT NOT NULL, provider_refund_id TEXT,
 requested_by TEXT NOT NULL, request_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 last_error TEXT, UNIQUE(requested_by,request_key)
);
CREATE UNIQUE INDEX payment_refund_request_active ON payment_refund_orders(refund_request_id) WHERE status IN ('pending','success');
CREATE UNIQUE INDEX payment_refund_provider_reference ON payment_refund_orders(channel, adapter_mode, merchant_id, provider_refund_id) WHERE provider_refund_id IS NOT NULL;
CREATE INDEX payment_refund_receipt_status ON payment_refund_orders(receipt_id,status);
CREATE TABLE payment_refund_notifications(
 id TEXT PRIMARY KEY, refund_id TEXT NOT NULL REFERENCES payment_refund_orders(id),
 body_digest TEXT NOT NULL, received_at TEXT NOT NULL
);
CREATE TABLE payment_reconciliation_records(
 id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payment_provider_orders(payment_id),
 channel TEXT NOT NULL, adapter_mode TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('matched','pending','closed','exception')),
 provider_state TEXT, error_code TEXT, request_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX payment_reconciliation_records_order ON payment_reconciliation_records(payment_id,created_at);
