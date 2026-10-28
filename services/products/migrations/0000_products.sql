CREATE TYPE "public"."product_kind" AS ENUM('goods', 'service');
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"kind" "product_kind" NOT NULL,
	"unit" text DEFAULT 'pcs' NOT NULL,
	"sale_price" numeric(20, 2),
	"purchase_price" numeric(20, 2),
	"vat_rate" numeric(5, 2) DEFAULT '11' NOT NULL,
	"revenue_account_id" uuid,
	"expense_account_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_prices" CHECK (coalesce("products"."sale_price", 0) >= 0 and coalesce("products"."purchase_price", 0) >= 0),
	CONSTRAINT "products_vat_rate" CHECK ("products"."vat_rate" between 0 and 100)
);

ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX "products_organization_id_sku_index" ON "products" USING btree ("organization_id","sku");
CREATE POLICY "products_tenant" ON "products" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);