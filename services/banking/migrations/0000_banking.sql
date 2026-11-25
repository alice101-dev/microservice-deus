CREATE TYPE "public"."statement_line_status" AS ENUM('unmatched', 'matched', 'posted', 'ignored');
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"bank_name" text NOT NULL,
	"account_number" text NOT NULL,
	"ledger_account_id" uuid NOT NULL,
	"opening_balance" numeric(20, 2) DEFAULT '0' NOT NULL,
	"opening_date" date NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "bank_accounts" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"traceparent" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"dead_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"line_date" date NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"reference" text,
	"fingerprint" text NOT NULL,
	"status" "statement_line_status" DEFAULT 'unmatched' NOT NULL,
	"payment_id" uuid,
	"counter_account_id" uuid,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statement_lines_amount" CHECK ("statement_lines"."amount" <> 0)
);

ALTER TABLE "statement_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;
CREATE UNIQUE INDEX "bank_accounts_organization_id_ledger_account_id_index" ON "bank_accounts" USING btree ("organization_id","ledger_account_id");
CREATE INDEX "outbox_due" ON "outbox" USING btree ("created_at") WHERE delivered_at is null and dead_at is null;
CREATE INDEX "outbox_delivered" ON "outbox" USING btree ("delivered_at") WHERE delivered_at is not null;
CREATE UNIQUE INDEX "statement_lines_fingerprint" ON "statement_lines" USING btree ("organization_id","bank_account_id","fingerprint");
CREATE UNIQUE INDEX "statement_lines_organization_id_payment_id_index" ON "statement_lines" USING btree ("organization_id","payment_id") WHERE "statement_lines"."payment_id" is not null;
CREATE INDEX "statement_lines_open" ON "statement_lines" USING btree ("organization_id","bank_account_id","status","line_date");
CREATE POLICY "bank_accounts_tenant" ON "bank_accounts" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY "statement_lines_tenant" ON "statement_lines" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);