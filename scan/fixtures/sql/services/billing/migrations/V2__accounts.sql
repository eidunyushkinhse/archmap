ALTER TABLE billing.accounts ADD COLUMN IF NOT EXISTS phone varchar(32);
ALTER TABLE billing.accounts RENAME COLUMN note TO comment;
ALTER TABLE ONLY invoices
    ADD COLUMN due_date date,
    ALTER COLUMN status DROP NOT NULL,
    ALTER COLUMN amount TYPE numeric(14, 2);
ALTER TABLE invoices ADD CONSTRAINT invoices_payer_fk FOREIGN KEY (payer_id) REFERENCES billing.accounts (id);
DROP TABLE IF EXISTS tmp_import;
ALTER DOMAIN money_amount SET NOT NULL;
CREATE AGGREGATE sum_amount (numeric) (sfunc = numeric_add, stype = numeric);
