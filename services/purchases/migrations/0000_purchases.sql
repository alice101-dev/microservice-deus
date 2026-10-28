CREATE TYPE "public"."bill_status" AS ENUM('draft', 'approved', 'void');
CREATE TABLE "bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" uuid,
	"description" text NOT NULL,
	"quantity" numeric(20, 4) NOT NULL,
	"unit_price" numeric(20, 2) NOT NULL,
	"vat_rate" numeric(5, 2) NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"vat_amount" numeric(20, 2) NOT NULL,
	"account_id" uuid NOT NULL,
	CONSTRAINT "bill_lines_positive" CHECK ("bill_lines"."quantity" > 0 and "bill_lines"."unit_price" >= 0)
);

ALTER TABLE "bill_lines" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "bill_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bill_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	CONSTRAINT "bill_payments_positive" CHECK ("bill_payments"."amount" > 0)
);

ALTER TABLE "bill_payments" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "bill_sequences" (
	"organization_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"last" integer NOT NULL,
	CONSTRAINT "bill_sequences_organization_id_year_pk" PRIMARY KEY("organization_id","year")
);

ALTER TABLE "bill_sequences" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text,
	"vendor_reference" text,
	"contact_id" uuid NOT NULL,
	"contact_name" text NOT NULL,
	"status" "bill_status" DEFAULT 'draft' NOT NULL,
	"bill_date" date NOT NULL,
	"due_date" date NOT NULL,
	"notes" text,
	"subtotal" numeric(20, 2) NOT NULL,
	"vat_total" numeric(20, 2) NOT NULL,
	"total" numeric(20, 2) NOT NULL,
	"amount_paid" numeric(20, 2) DEFAULT '0' NOT NULL,
	"created_by" uuid NOT NULL,
	"approved_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bills_totals" CHECK ("bills"."total" = "bills"."subtotal" + "bills"."vat_total"),
	CONSTRAINT "bills_paid" CHECK ("bills"."amount_paid" >= 0 and "bills"."amount_paid" <= "bills"."total"),
	CONSTRAINT "bills_due" CHECK ("bills"."due_date" >= "bills"."bill_date"),
	CONSTRAINT "bills_number" CHECK (("bills"."status" = 'draft') = ("bills"."number" is null))
);

ALTER TABLE "bills" ENABLE ROW LEVEL SECURITY;
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

ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "bill_payments" ADD CONSTRAINT "bill_payments_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE restrict ON UPDATE no action;
CREATE UNIQUE INDEX "bill_lines_bill_id_line_no_index" ON "bill_lines" USING btree ("bill_id","line_no");
CREATE INDEX "bill_payments_organization_id_payment_id_index" ON "bill_payments" USING btree ("organization_id","payment_id");
CREATE INDEX "bill_payments_bill_id_index" ON "bill_payments" USING btree ("bill_id");
CREATE UNIQUE INDEX "bills_organization_id_number_index" ON "bills" USING btree ("organization_id","number") WHERE "bills"."number" is not null;
CREATE UNIQUE INDEX "bills_organization_id_contact_id_vendor_reference_index" ON "bills" USING btree ("organization_id","contact_id","vendor_reference") WHERE "bills"."vendor_reference" is not null;
CREATE INDEX "bills_organization_id_status_bill_date_index" ON "bills" USING btree ("organization_id","status","bill_date");
CREATE INDEX "bills_organization_id_contact_id_index" ON "bills" USING btree ("organization_id","contact_id");
CREATE INDEX "outbox_due" ON "outbox" USING btree ("created_at") WHERE delivered_at is null and dead_at is null;
CREATE INDEX "outbox_delivered" ON "outbox" USING btree ("delivered_at") WHERE delivered_at is not null;
CREATE POLICY "bill_lines_tenant" ON "bill_lines" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY "bill_payments_tenant" ON "bill_payments" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY "bill_sequences_tenant" ON "bill_sequences" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY "bills_tenant" ON "bills" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);