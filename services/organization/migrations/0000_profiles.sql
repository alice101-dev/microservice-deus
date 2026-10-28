CREATE TABLE "profiles" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"tax_id" text,
	"address" text,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"fiscal_year_start_month" smallint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_currency_idr" CHECK ("profiles"."currency" = 'IDR'),
	CONSTRAINT "profiles_fiscal_month" CHECK ("profiles"."fiscal_year_start_month" between 1 and 12),
	CONSTRAINT "profiles_tax_id_digits" CHECK ("profiles"."tax_id" is null or "profiles"."tax_id" ~ '^[0-9]{15,16}$')
);

ALTER TABLE "profiles" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "profiles_tenant" ON "profiles" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);