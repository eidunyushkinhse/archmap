CREATE TABLE payments (id bigint PRIMARY KEY, invoice_id bigint REFERENCES invoices, paid boolean);
ALTER TABLE payments RENAME TO invoice_payments;
ALTER TABLE invoice_payments DROP COLUMN paid;
