CREATE TYPE "public"."statement_kind" AS ENUM('income-statement', 'balance-sheet');
CREATE TABLE "statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "statement_kind" NOT NULL,
	"period_from" date,
	"period_to" date NOT NULL,
	"data" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "statements" ENABLE ROW LEVEL SECURITY;
CREATE INDEX "statements_organization_id_kind_period_to_index" ON "statements" USING btree ("organization_id","kind","period_to");
CREATE POLICY "statements_tenant" ON "statements" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);