CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'issued', 'void');
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" uuid,
	"description" text NOT NULL,
	"quantity" numeric(20, 4) NOT NULL,
	"unit_price" numeric(20, 2) NOT NULL,
	"vat_rate" numeric(5, 2) NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"vat_amount" numeric(20, 2) NOT NULL,
	"revenue_account_id" uuid NOT NULL,
	CONSTRAINT "invoice_lines_positive" CHECK ("invoice_lines"."quantity" > 0 and "invoice_lines"."unit_price" >= 0)
);

ALTER TABLE "invoice_lines" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "invoice_sequences" (
	"organization_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"last" integer NOT NULL,
	CONSTRAINT "invoice_sequences_organization_id_year_pk" PRIMARY KEY("organization_id","year")
);

ALTER TABLE "invoice_sequences" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text,
	"contact_id" uuid NOT NULL,
	"contact_name" text NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"notes" text,
	"subtotal" numeric(20, 2) NOT NULL,
	"vat_total" numeric(20, 2) NOT NULL,
	"total" numeric(20, 2) NOT NULL,
	"amount_paid" numeric(20, 2) DEFAULT '0' NOT NULL,
	"created_by" uuid NOT NULL,
	"issued_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_totals" CHECK ("invoices"."total" = "invoices"."subtotal" + "invoices"."vat_total"),
	CONSTRAINT "invoices_paid" CHECK ("invoices"."amount_paid" >= 0 and "invoices"."amount_paid" <= "invoices"."total"),
	CONSTRAINT "invoices_due" CHECK ("invoices"."due_date" >= "invoices"."issue_date"),
	CONSTRAINT "invoices_number" CHECK (("invoices"."status" = 'draft') = ("invoices"."number" is null))
);

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
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

ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "invoice_lines_invoice_id_line_no_index" ON "invoice_lines" USING btree ("invoice_id","line_no");
CREATE UNIQUE INDEX "invoices_organization_id_number_index" ON "invoices" USING btree ("organization_id","number") WHERE "invoices"."number" is not null;
CREATE INDEX "invoices_organization_id_status_issue_date_index" ON "invoices" USING btree ("organization_id","status","issue_date");
CREATE INDEX "invoices_organization_id_contact_id_index" ON "invoices" USING btree ("organization_id","contact_id");
CREATE INDEX "outbox_due" ON "outbox" USING btree ("created_at") WHERE delivered_at is null and dead_at is null;
CREATE INDEX "outbox_delivered" ON "outbox" USING btree ("delivered_at") WHERE delivered_at is not null;
CREATE POLICY "invoice_lines_tenant" ON "invoice_lines" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY "invoice_sequences_tenant" ON "invoice_sequences" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY "invoices_tenant" ON "invoices" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);