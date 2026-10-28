CREATE TABLE "invoice_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount" numeric(20, 2) NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	CONSTRAINT "invoice_payments_positive" CHECK ("invoice_payments"."amount" > 0)
);

ALTER TABLE "invoice_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;
CREATE INDEX "invoice_payments_organization_id_payment_id_index" ON "invoice_payments" USING btree ("organization_id","payment_id");
CREATE INDEX "invoice_payments_invoice_id_index" ON "invoice_payments" USING btree ("invoice_id");
CREATE POLICY "invoice_payments_tenant" ON "invoice_payments" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);