import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ServiceVerifier, Verifier } from "@deus/auth";
import { loadConfig } from "@deus/config";
import { createTestDatabase } from "@deus/db/testing";
import { createLogger } from "@deus/logger";
import { createRelay } from "@deus/outbox";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { PDFDocument } from "pdf-lib";
import { createApp } from "../src/app";
import { deliveryHandlers, type Mail } from "../src/delivery";
import { schema } from "../src/schema";

const url = process.env.DATABASE_TEST_URL;
const { telemetry } = startTestTelemetry("notification");
afterAll(() => telemetry.shutdown());

const ORG = "00000000-0000-4000-8000-00000000000a";
const verify: Verifier = async (token) => ({
  userId: "00000000-0000-4000-8000-000000000001",
  email: "user@example.com",
  organizationId: token,
  token,
});
const verifyService: ServiceVerifier = async (token) => {
  if (!token.startsWith("svc:")) throw new Error("not a service token");
  return { service: token.slice(4), namespace: "staging-deus" };
};
const data = {
  invoiceId: "00000000-0000-4000-8000-000000000501",
  number: "INV/2026/0007",
  issueDate: "2026-10-28",
  dueDate: "2026-11-11",
  customer: { name: "PT Surel Lancar", address: null, taxId: null },
  lines: [{ description: "Kopi Arabika 250g", quantity: "3", unitPrice: "85000.00", amount: "255000.00" }],
  subtotal: "255000.00",
  vatTotal: "28050.00",
  total: "283050.00",
  notes: null,
};

describe.skipIf(!url)("notification against PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase<typeof schema>>>;
  let app: ReturnType<typeof createApp>;
  const queue = (key: string, token = "svc:sales") =>
    app.handle(
      new Request("http://localhost/internal/notification/messages", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": key },
        body: JSON.stringify({ organizationId: ORG, template: "invoice.issued", to: "finance@surel.example", data }),
      }),
    );
  const list = async () =>
    (await (
      await app.handle(
        new Request("http://localhost/api/notification/messages", { headers: { authorization: `Bearer ${ORG}` } }),
      )
    ).json()) as Array<{ status: string; subject: string | null; lastError: string | null }>;

  beforeAll(async () => {
    database = await createTestDatabase({
      url: url ?? "",
      service: "notification",
      serviceDirectory: join(import.meta.dir, ".."),
      schema,
    });
    app = createApp({
      config: loadConfig({}, { SERVICE_NAME: "notification" }),
      logger: createLogger({ name: "notification" }),
      db: database.db,
      verify,
      verifyService,
    });
  });
  afterAll(() => database.cleanup());

  test("queues an email once per key and only for allowed services", async () => {
    expect((await queue("evt-1")).status).toBe(202);
    expect((await queue("evt-1")).status).toBe(200);
    expect((await queue("evt-2", "svc:ledger")).status).toBe(403);
    expect(await list()).toHaveLength(1);
  });

  test("sends with the invoice PDF and records failures before retrying", async () => {
    const sent: Mail[] = [];
    let smtpUp = false;
    const relay = createRelay({
      db: database.db,
      logger: createLogger({ name: "notification" }),
      handlers: deliveryHandlers({
        db: database.db,
        logger: createLogger({ name: "notification" }),
        profile: async () => ({
          organizationId: ORG,
          legalName: "PT Maju Bersama",
          taxId: "0123456789012345",
          address: "Jl. Sudirman 1",
          currency: "IDR",
          fiscalYearStartMonth: 1,
        }),
        send: async (mail) => {
          if (!smtpUp) throw new Error("connect ECONNREFUSED mailpit-smtp:25");
          sent.push(mail);
          return { messageId: "<m1@deus>" };
        },
      }),
    });
    await relay.runOnce();
    expect((await list())[0]).toMatchObject({ status: "queued", lastError: "connect ECONNREFUSED mailpit-smtp:25" });

    smtpUp = true;
    await database.db.execute("update outbox set available_at = now()");
    await relay.runOnce();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "finance@surel.example",
      subject: "Invoice INV/2026/0007 dari PT Maju Bersama",
    });
    expect(sent[0]?.attachments[0]?.filename).toBe("invoice-INV-2026-0007.pdf");
    expect((await PDFDocument.load(sent[0]?.attachments[0]?.content ?? new Uint8Array())).getPageCount()).toBe(1);
    expect((await list())[0]).toMatchObject({
      status: "sent",
      lastError: null,
      subject: "Invoice INV/2026/0007 dari PT Maju Bersama",
    });
  });
});
