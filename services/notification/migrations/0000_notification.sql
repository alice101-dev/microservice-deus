CREATE TYPE "public"."message_status" AS ENUM('queued', 'sent');
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"template" text NOT NULL,
	"recipient" text NOT NULL,
	"subject" text,
	"data" jsonb NOT NULL,
	"status" "message_status" DEFAULT 'queued' NOT NULL,
	"source_service" text NOT NULL,
	"source_key" text NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
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

CREATE UNIQUE INDEX "messages_source" ON "messages" USING btree ("organization_id","source_service","source_key");
CREATE INDEX "outbox_due" ON "outbox" USING btree ("created_at") WHERE delivered_at is null and dead_at is null;
CREATE INDEX "outbox_delivered" ON "outbox" USING btree ("delivered_at") WHERE delivered_at is not null;
CREATE POLICY "messages_tenant" ON "messages" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);