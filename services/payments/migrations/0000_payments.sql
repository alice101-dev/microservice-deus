CREATE TYPE "public"."payment_kind" AS ENUM('receipt', 'disbursement');
CREATE TYPE "public"."payment_status" AS ENUM('recorded', 'void');
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

CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	CONSTRAINT "payment_allocations_positive" CHECK ("payment_allocations"."amount" > 0)
);

ALTER TABLE "payment_allocations" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "payment_sequences" (
	"organization_id" uuid NOT NULL,
	"kind" "payment_kind" NOT NULL,
	"year" integer NOT NULL,
	"last" integer NOT NULL,
	CONSTRAINT "payment_sequences_organization_id_kind_year_pk" PRIMARY KEY("organization_id","kind","year")
);

ALTER TABLE "payment_sequences" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"kind" "payment_kind" NOT NULL,
	"status" "payment_status" DEFAULT 'recorded' NOT NULL,
	"contact_id" uuid NOT NULL,
	"contact_name" text NOT NULL,
	"payment_date" date NOT NULL,
	"cash_account_id" uuid NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"reference" text,
	"notes" text,
	"created_by" uuid NOT NULL,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_positive" CHECK ("payments"."amount" > 0)
);

ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "outbox_due" ON "outbox" USING btree ("created_at") WHERE delivered_at is null and dead_at is null;
CREATE INDEX "outbox_delivered" ON "outbox" USING btree ("delivered_at") WHERE delivered_at is not null;
CREATE UNIQUE INDEX "payment_allocations_payment_id_document_id_index" ON "payment_allocations" USING btree ("payment_id","document_id");
CREATE INDEX "payment_allocations_organization_id_document_id_index" ON "payment_allocations" USING btree ("organization_id","document_id");
CREATE UNIQUE INDEX "payments_organization_id_number_index" ON "payments" USING btree ("organization_id","number");
CREATE INDEX "payments_organization_id_kind_payment_date_index" ON "payments" USING btree ("organization_id","kind","payment_date");
CREATE INDEX "payments_organization_id_contact_id_index" ON "payments" USING btree ("organization_id","contact_id");
CREATE POLICY "payment_allocations_tenant" ON "payment_allocations" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY "payment_sequences_tenant" ON "payment_sequences" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
CREATE POLICY "payments_tenant" ON "payments" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);