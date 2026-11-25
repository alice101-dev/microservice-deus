CREATE TYPE "public"."journal_status" AS ENUM('draft', 'posted');
CREATE TABLE "closed_periods" (
	"organization_id" uuid NOT NULL,
	"period" text NOT NULL,
	"closed_by" uuid NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "closed_periods_organization_id_period_pk" PRIMARY KEY("organization_id","period"),
	CONSTRAINT "closed_periods_format" CHECK ("closed_periods"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);

ALTER TABLE "closed_periods" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journal_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"debit" numeric(20, 2) DEFAULT '0' NOT NULL,
	"credit" numeric(20, 2) DEFAULT '0' NOT NULL,
	"memo" text,
	CONSTRAINT "journal_lines_one_side" CHECK ("journal_lines"."debit" >= 0 and "journal_lines"."credit" >= 0 and ("journal_lines"."debit" > 0) <> ("journal_lines"."credit" > 0))
);

ALTER TABLE "journal_lines" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entry_date" date NOT NULL,
	"description" text NOT NULL,
	"status" "journal_status" DEFAULT 'draft' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_id" text,
	"idempotency_key" text,
	"request_hash" text,
	"reversal_of" uuid,
	"created_by" uuid NOT NULL,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "journals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "journals" ADD CONSTRAINT "journals_reversal_of_journals_id_fk" FOREIGN KEY ("reversal_of") REFERENCES "public"."journals"("id") ON DELETE restrict ON UPDATE no action;
CREATE UNIQUE INDEX "journal_lines_journal_id_line_no_index" ON "journal_lines" USING btree ("journal_id","line_no");
CREATE INDEX "journal_lines_organization_id_account_id_index" ON "journal_lines" USING btree ("organization_id","account_id");
CREATE UNIQUE INDEX "journals_organization_id_idempotency_key_index" ON "journals" USING btree ("organization_id","idempotency_key") WHERE "journals"."idempotency_key" is not null;
CREATE UNIQUE INDEX "journals_reversal_of_index" ON "journals" USING btree ("reversal_of") WHERE "journals"."reversal_of" is not null;
CREATE INDEX "journals_organization_id_entry_date_index" ON "journals" USING btree ("organization_id","entry_date");
CREATE POLICY "closed_periods_tenant" ON "closed_periods" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY "journal_lines_tenant" ON "journal_lines" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY "journals_tenant" ON "journals" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);