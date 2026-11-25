CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_customer" boolean DEFAULT false NOT NULL,
	"is_vendor" boolean DEFAULT false NOT NULL,
	"email" text,
	"phone" text,
	"tax_id" text,
	"address" text,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_role" CHECK ("contacts"."is_customer" or "contacts"."is_vendor"),
	CONSTRAINT "contacts_tax_id_digits" CHECK ("contacts"."tax_id" is null or "contacts"."tax_id" ~ '^[0-9]{15,16}$'),
	CONSTRAINT "contacts_payment_terms" CHECK ("contacts"."payment_terms_days" between 0 and 365)
);

ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;
CREATE INDEX "contacts_organization_id_name_index" ON "contacts" USING btree ("organization_id","name");
CREATE POLICY "contacts_tenant" ON "contacts" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);