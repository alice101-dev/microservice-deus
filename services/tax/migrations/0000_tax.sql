CREATE TYPE "public"."vat_return_status" AS ENUM('draft', 'filed');
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

CREATE TABLE "vat_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"period" text NOT NULL,
	"output_vat" numeric(20, 2) NOT NULL,
	"input_vat" numeric(20, 2) NOT NULL,
	"payable" numeric(20, 2) NOT NULL,
	"carried_forward" numeric(20, 2) NOT NULL,
	"status" "vat_return_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"filed_by" uuid,
	"filed_at" timestamp with time zone,
	"calculated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vat_returns_period" CHECK ("vat_returns"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "vat_returns_amounts" CHECK ("vat_returns"."output_vat" >= 0 and "vat_returns"."input_vat" >= 0 and "vat_returns"."payable" >= 0 and "vat_returns"."carried_forward" >= 0)
);

ALTER TABLE "vat_returns" ENABLE ROW LEVEL SECURITY;
CREATE INDEX "outbox_due" ON "outbox" USING btree ("created_at") WHERE delivered_at is null and dead_at is null;
CREATE INDEX "outbox_delivered" ON "outbox" USING btree ("delivered_at") WHERE delivered_at is not null;
CREATE UNIQUE INDEX "vat_returns_organization_id_period_index" ON "vat_returns" USING btree ("organization_id","period");
CREATE POLICY "vat_returns_tenant" ON "vat_returns" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);