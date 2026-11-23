-- Add indexed lookups for bill-ledger reads. Existing unique payment constraints stay in force.
CREATE INDEX finance_receipt_bill_status ON receipts(json_extract(data,'$.billId'),status);
CREATE INDEX finance_refund_bill_status ON refundRequests(json_extract(data,'$.billId'),status);
CREATE INDEX finance_payment_bill ON payments(json_extract(data,'$.billId'));
CREATE INDEX finance_invoice_bill ON invoiceRequests(json_extract(data,'$.billId'));
CREATE INDEX finance_offline_bill ON offlinePayments(json_extract(data,'$.billId'));
CREATE INDEX finance_bill_previous ON bills(json_extract(data,'$.replaces'));
CREATE INDEX finance_bill_month_owner ON bills(month,owner);
CREATE INDEX finance_pending_adjustment ON adjustments(status,outlet,owner);
CREATE INDEX billing_agreement_status_id ON agreements(status,id);

-- A historical period that needs policy or evidence is recorded once until it is handled by finance.
CREATE TABLE billing_catchup_reviews(
 agreement_id TEXT NOT NULL REFERENCES agreements(id),
 month TEXT NOT NULL,
 outlet TEXT NOT NULL REFERENCES outlets(id),
 reason TEXT NOT NULL,
 request_id TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(agreement_id,month)
);
CREATE INDEX billing_catchup_review_month ON billing_catchup_reviews(month,outlet);

