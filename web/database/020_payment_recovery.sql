-- Expand provider orders and add durable finance evidence without rewriting booked transactions.
ALTER TABLE payment_provider_orders ADD COLUMN gateway_environment TEXT
 CHECK(gateway_environment IN ('production','sandbox','test','mock'));

CREATE TABLE payment_exceptions (
 id TEXT PRIMARY KEY,
 payment_id TEXT NOT NULL REFERENCES payment_provider_orders(payment_id),
 bill_id TEXT NOT NULL REFERENCES bills(id),
 provider_transaction TEXT NOT NULL,
 channel TEXT NOT NULL CHECK(channel IN ('wechat','alipay')),
 adapter_mode TEXT NOT NULL CHECK(adapter_mode IN ('real','mock')),
 merchant_id TEXT NOT NULL, app_id TEXT NOT NULL,
 reason TEXT NOT NULL,
 amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
 currency TEXT NOT NULL CHECK(currency='CNY'),
 provider_paid_at TEXT NOT NULL,
 observed_by TEXT NOT NULL,
 request_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status='open'),
 created_at TEXT NOT NULL,
 UNIQUE(payment_id,provider_transaction)
);
CREATE INDEX payment_exceptions_bill ON payment_exceptions(bill_id, status);
CREATE INDEX payment_exceptions_queue ON payment_exceptions(adapter_mode,status,created_at,id);

ALTER TABLE payment_refund_orders ADD COLUMN query_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_refund_orders ADD COLUMN last_query_at TEXT;
ALTER TABLE payment_refund_orders ADD COLUMN next_query_at TEXT;
CREATE INDEX payment_refunds_due ON payment_refund_orders(channel,adapter_mode,status,next_query_at,query_attempts);

CREATE TABLE payment_refund_idempotency (
 subject TEXT NOT NULL,
 request_key TEXT NOT NULL,
 refund_id TEXT NOT NULL REFERENCES payment_refund_orders(id),
 PRIMARY KEY(subject,request_key)
);
INSERT INTO payment_refund_idempotency(subject,request_key,refund_id)
 SELECT requested_by, request_key, id FROM payment_refund_orders;
