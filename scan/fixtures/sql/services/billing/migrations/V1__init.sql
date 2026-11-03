-- Начальная схема; точка с запятой в комментарии не делит; инструкцию
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

/* Многострочный комментарий: CREATE TABLE fake (x int); */
CREATE TABLE IF NOT EXISTS billing.accounts (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    "Email" varchar(255) NOT NULL UNIQUE,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    note text
);

CREATE TABLE invoices (
    id bigserial,
    account_id uuid NOT NULL REFERENCES billing.accounts (id) ON DELETE CASCADE,
    amount numeric(12, 2) NOT NULL CHECK (amount >= 0),
    status varchar(16) NOT NULL DEFAULT 'new;draft',
    CONSTRAINT invoices_pk PRIMARY KEY (id)
);

CREATE TABLE tmp_import (line text);

CREATE INDEX invoices_account_idx ON invoices (account_id);
INSERT INTO invoices (account_id, amount) VALUES ('x', 1);

CREATE OR REPLACE FUNCTION touch() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now(); -- здесь точка с запятой внутри функции
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
