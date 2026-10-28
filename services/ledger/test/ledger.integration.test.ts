import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ServiceVerifier, Verifier } from "@deus/auth";
import type { AccountRef } from "@deus/clients";
import { loadConfig } from "@deus/config";
import { createTestDatabase } from "@deus/db/testing";
import { createLogger } from "@deus/logger";
import { startTestTelemetry } from "@deus/telemetry/testing";
import { sql } from "drizzle-orm";
import { createApp } from "../src/app";
import { schema } from "../src/schema";

const url = process.env.DATABASE_TEST_URL;
const { telemetry } = startTestTelemetry("ledger");
afterAll(() => telemetry.shutdown());

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const ORG_C = "00000000-0000-4000-8000-00000000000c";
const ACTOR = "00000000-0000-4000-8000-000000000002";
const CASH = "00000000-0000-4000-8000-000000000101";
const REVENUE = "00000000-0000-4000-8000-000000000401";
const EXPENSE = "00000000-0000-4000-8000-000000000501";
const RETIRED = "00000000-0000-4000-8000-000000000599";
const ASSETS = "00000000-0000-4000-8000-000000000100";
const UNKNOWN = "00000000-0000-4000-8000-000000000999";
const ACCOUNTS: AccountRef[] = [
  { id: ASSETS, code: "1-0000", name: "Aset", type: "asset", active: true, parentId: null, postable: false },
  { id: CASH, code: "1-1100", name: "Kas", type: "asset", active: true, parentId: ASSETS, postable: true },
  {
    id: REVENUE,
    code: "4-1000",
    name: "Pendapatan Jasa",
    type: "revenue",
    active: true,
    parentId: ASSETS,
    postable: true,
  },
  { id: EXPENSE, code: "6-1000", name: "Beban Gaji", type: "expense", active: true, parentId: ASSETS, postable: true },
  { id: RETIRED, code: "6-9000", name: "Beban Lama", type: "expense", active: false, parentId: ASSETS, postable: true },
];

const verify: Verifier = async (token) => ({
  userId: "00000000-0000-4000-8000-000000000001",
  email: "user@example.com",
  organizationId: token === "no-org" ? null : token,
  token,
});

interface JournalBody {
  id: string;
  status: string;
  total: string;
  reversalOf: string | null;
  lines: Array<{ lineNo: number; accountId: string; debit: string; credit: string }>;
}

const verifyService: ServiceVerifier = async (token) => {
  if (!token.startsWith("svc:")) throw new Error("not a service token");
  return { service: token.slice(4), namespace: "staging-deus" };
};

describe.skipIf(!url)("ledger against PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase<typeof schema>>>;
  let app: ReturnType<typeof createApp>;
  const lookups: Array<{ ids: string[]; organizationId: string }> = [];
  const call = (
    path: string,
    token: string | undefined,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    app.handle(
      new Request(`http://localhost/api/ledger${path}`, {
        method: init.method ?? "GET",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
      }),
    );
  const sale = (amount: string, date = "2026-01-15", extra: Record<string, unknown> = {}) => ({
    date,
    description: "Jasa konsultasi",
    lines: [
      { accountId: CASH, debit: amount },
      { accountId: REVENUE, credit: amount },
    ],
    ...extra,
  });

  beforeAll(async () => {
    database = await createTestDatabase({
      url: url ?? "",
      service: "ledger",
      serviceDirectory: join(import.meta.dir, ".."),
      schema,
    });
    app = createApp({
      config: loadConfig({}, { SERVICE_NAME: "ledger" }),
      logger: createLogger({ name: "ledger" }),
      db: database.db,
      verify,
      verifyService,
      accounts: async (ids, organizationId) => {
        lookups.push({ ids, organizationId });
        return ACCOUNTS.filter((account) => ids.includes(account.id));
      },
    });
  });
  afterAll(() => database.cleanup());

  test("posts a balanced journal and rejects unbalanced or one-sided lines", async () => {
    const created = await call("/journals", ORG_A, { method: "POST", body: sale("1500000") });
    expect(created.status).toBe(201);
    const journal = (await created.json()) as JournalBody;
    expect(journal.status).toBe("posted");
    expect(journal.total).toBe("1500000.00");
    expect(journal.lines.map((line) => [line.lineNo, line.debit, line.credit])).toEqual([
      [1, "1500000.00", "0.00"],
      [2, "0.00", "1500000.00"],
    ]);

    const unbalanced = await call("/journals", ORG_A, {
      method: "POST",
      body: {
        ...sale("10"),
        lines: [
          { accountId: CASH, debit: "10" },
          { accountId: REVENUE, credit: "9.99" },
        ],
      },
    });
    expect(unbalanced.status).toBe(422);
    expect(((await unbalanced.json()) as { errors: unknown }).errors).toEqual({ debit: "10.00", credit: "9.99" });

    const bothSides = await call("/journals", ORG_A, {
      method: "POST",
      body: {
        ...sale("10"),
        lines: [
          { accountId: CASH, debit: "10", credit: "10" },
          { accountId: REVENUE, credit: "10" },
        ],
      },
    });
    expect(bothSides.status).toBe(422);

    const badAmount = await call("/journals", ORG_A, { method: "POST", body: sale("10.001") });
    expect(badAmount.status).toBe(400);
  });

  test("refuses unknown, inactive and header accounts", async () => {
    const unknown = await call("/journals", ORG_A, {
      method: "POST",
      body: {
        ...sale("5"),
        lines: [
          { accountId: UNKNOWN, debit: "5" },
          { accountId: REVENUE, credit: "5" },
        ],
      },
    });
    expect(unknown.status).toBe(422);
    expect(((await unknown.json()) as { errors: unknown }).errors).toEqual({ missing: [UNKNOWN] });

    const inactive = await call("/journals", ORG_A, {
      method: "POST",
      body: {
        ...sale("5"),
        lines: [
          { accountId: RETIRED, debit: "5" },
          { accountId: CASH, credit: "5" },
        ],
      },
    });
    expect(inactive.status).toBe(422);

    const header = await call("/journals", ORG_A, {
      method: "POST",
      body: {
        ...sale("5"),
        lines: [
          { accountId: ASSETS, debit: "5" },
          { accountId: REVENUE, credit: "5" },
        ],
      },
    });
    expect(header.status).toBe(422);
    expect(((await header.json()) as { errors: unknown }).errors).toEqual({ headers: [ASSETS] });
  });

  test("replays a request with the same Idempotency-Key and rejects a different body", async () => {
    const headers = { "idempotency-key": "invoice-2026-0001" };
    const first = await call("/journals", ORG_A, { method: "POST", body: sale("250000"), headers });
    expect(first.status).toBe(201);
    const second = await call("/journals", ORG_A, { method: "POST", body: sale("250000"), headers });
    expect(second.status).toBe(200);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(((await second.json()) as JournalBody).id).toBe(((await first.json()) as JournalBody).id);

    const different = await call("/journals", ORG_A, { method: "POST", body: sale("250001"), headers });
    expect(different.status).toBe(422);

    const otherTenant = await call("/journals", ORG_B, { method: "POST", body: sale("250000"), headers });
    expect(otherTenant.status).toBe(201);

    const concurrent = await Promise.all(
      [1, 2, 3].map(() =>
        call("/journals", ORG_A, { method: "POST", body: sale("7"), headers: { "idempotency-key": "race" } }),
      ),
    );
    const ids = new Set(
      await Promise.all(concurrent.map(async (response) => ((await response.json()) as JournalBody).id)),
    );
    expect(ids.size).toBe(1);
  });

  test("keeps drafts editable only until they are posted, and posted journals immutable in the database", async () => {
    const draft = (await (
      await call("/journals", ORG_A, { method: "POST", body: sale("1000", "2026-01-20", { post: false }) })
    ).json()) as JournalBody;
    expect(draft.status).toBe("draft");
    const posted = await call(`/journals/${draft.id}/post`, ORG_A, { method: "POST" });
    expect(posted.status).toBe(200);
    expect(((await posted.json()) as JournalBody).status).toBe("posted");
    expect((await call(`/journals/${draft.id}/post`, ORG_A, { method: "POST" })).status).toBe(409);

    expect(
      database.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.organization_id', ${ORG_A}, true)`);
        await tx.execute(sql`update journal_lines set debit = 1 where journal_id = ${draft.id} and line_no = 1`);
      }),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining("cannot be changed") } });
    expect(
      database.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.organization_id', ${ORG_A}, true)`);
        await tx.execute(sql`delete from journals where id = ${draft.id}`);
      }),
    ).rejects.toMatchObject({ cause: { message: expect.stringContaining("cannot be changed") } });
  });

  test("reverses a posted journal once with the sides swapped", async () => {
    const original = (await (
      await call("/journals", ORG_A, { method: "POST", body: sale("300", "2026-01-25") })
    ).json()) as JournalBody;
    const reversed = await call(`/journals/${original.id}/reverse`, ORG_A, {
      method: "POST",
      body: { date: "2026-01-31" },
    });
    expect(reversed.status).toBe(201);
    const reversal = (await reversed.json()) as JournalBody;
    expect(reversal.reversalOf).toBe(original.id);
    expect(reversal.lines.map((line) => [line.accountId, line.debit, line.credit])).toEqual([
      [CASH, "0.00", "300.00"],
      [REVENUE, "300.00", "0.00"],
    ]);
    expect((await call(`/journals/${original.id}/reverse`, ORG_A, { method: "POST" })).status).toBe(409);
    expect((await call(`/journals/${reversal.id}/reverse`, ORG_A, { method: "POST" })).status).toBe(422);
  });

  test("closes a period: posting into it is refused, drafts stay allowed", async () => {
    expect((await call("/periods/2025-12/close", ORG_A, { method: "POST" })).status).toBe(201);
    expect((await call("/periods/2025-12/close", ORG_A, { method: "POST" })).status).toBe(409);
    expect((await call("/periods/2025-13/close", ORG_A, { method: "POST" })).status).toBe(400);

    const refused = await call("/journals", ORG_A, { method: "POST", body: sale("10", "2025-12-31") });
    expect(refused.status).toBe(422);
    const draft = await call("/journals", ORG_A, { method: "POST", body: sale("10", "2025-12-31", { post: false }) });
    expect(draft.status).toBe(201);
    const draftId = ((await draft.json()) as JournalBody).id;
    expect((await call(`/journals/${draftId}/post`, ORG_A, { method: "POST" })).status).toBe(422);

    expect((await call("/periods", ORG_A)).status).toBe(200);
    expect(await (await call("/periods", ORG_B)).json()).toEqual([]);
  });

  test("builds a balanced trial balance from posted journals up to a date", async () => {
    await call("/journals", ORG_A, {
      method: "POST",
      body: {
        date: "2026-02-01",
        description: "Gaji Januari",
        lines: [
          { accountId: EXPENSE, debit: "400000.50" },
          { accountId: CASH, credit: "400000.50" },
        ],
      },
    });
    const response = await call("/trial-balance?asOf=2026-01-31", ORG_A);
    expect(response.status).toBe(200);
    const report = (await response.json()) as {
      rows: Array<{ code: string; debit: string; credit: string; balance: string }>;
      debit: string;
      credit: string;
      balanced: boolean;
    };
    expect(report.balanced).toBe(true);
    expect(report.debit).toBe(report.credit);
    expect(report.rows.map((row) => row.code)).toEqual(["1-1100", "4-1000"]);
    const cash = report.rows.find((row) => row.code === "1-1100");
    expect(cash?.balance).toBe("1751007.00");
    const revenue = report.rows.find((row) => row.code === "4-1000");
    expect(revenue?.balance).toBe("1751007.00");

    const later = (await (await call("/trial-balance?asOf=2026-02-28", ORG_A)).json()) as typeof report;
    expect(later.rows.map((row) => row.code)).toEqual(["1-1100", "4-1000", "6-1000"]);
    expect(later.rows.find((row) => row.code === "1-1100")?.balance).toBe("1351006.50");
    expect(later.balanced).toBe(true);
  });

  test("isolates tenants and requires an organization", async () => {
    const ofB = (await (await call("/journals", ORG_B)).json()) as JournalBody[];
    expect(ofB).toHaveLength(1);
    const ofA = (await (await call("/journals", ORG_A)).json()) as JournalBody[];
    expect((await call(`/journals/${ofA[0]?.id}`, ORG_B)).status).toBe(404);
    const drafts = (await (await call("/journals?status=draft", ORG_A)).json()) as JournalBody[];
    expect(drafts.map((journal) => journal.status)).toEqual(["draft"]);
    expect((await call("/journals", "no-org")).status).toBe(403);
    expect((await call("/journals", undefined)).status).toBe(401);
  });

  test("posts journals for other services with their name as the source, idempotently", async () => {
    const internal = (token: string | undefined, body: unknown, key?: string) =>
      app.handle(
        new Request("http://localhost/internal/ledger/journals", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(key ? { "idempotency-key": key } : {}),
          },
          body: JSON.stringify(body),
        }),
      );
    const invoice = {
      organizationId: ORG_C,
      createdBy: ACTOR,
      date: "2026-03-10",
      description: "Invoice INV-0001",
      sourceId: "inv-1",
      lines: [
        { accountId: CASH, debit: "110000" },
        { accountId: REVENUE, credit: "110000" },
      ],
    };
    const event = "0b6f4c1e-7c0e-4f61-9f0a-5d1a2b3c4d5e";
    const created = await internal("svc:sales", invoice, event);
    expect(created.status).toBe(201);
    const journal = (await created.json()) as JournalBody & { source: string; sourceId: string };
    expect(journal).toMatchObject({ status: "posted", source: "sales", sourceId: "inv-1", total: "110000.00" });
    expect(lookups.at(-1)?.organizationId).toBe(ORG_C);

    const again = await internal("svc:sales", invoice, event);
    expect(again.status).toBe(200);
    expect(((await again.json()) as JournalBody).id).toBe(journal.id);

    expect((await internal("svc:sales", invoice)).status).toBe(400);
    expect((await internal("svc:reporting", invoice, "k-2")).status).toBe(403);
    expect((await internal(ORG_C, invoice, "k-3")).status).toBe(401);
    const ofC = (await (await call("/journals", ORG_C)).json()) as JournalBody[];
    expect(ofC.map((row) => row.id)).toEqual([journal.id]);

    const reverse = (token: string, sourceId: string) =>
      app.handle(
        new Request("http://localhost/internal/ledger/journals/reverse", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ organizationId: ORG_C, createdBy: ACTOR, sourceId, date: "2026-03-20" }),
        }),
      );
    expect((await reverse("svc:purchases", "inv-1")).status).toBe(404);
    expect((await reverse("svc:sales", "inv-unknown")).status).toBe(404);
    const reversed = await reverse("svc:sales", "inv-1");
    expect(reversed.status).toBe(201);
    const reversal = (await reversed.json()) as JournalBody;
    expect(reversal).toMatchObject({ reversalOf: journal.id, status: "posted" });
    const repeated = await reverse("svc:sales", "inv-1");
    expect(repeated.status).toBe(200);
    expect(((await repeated.json()) as JournalBody).id).toBe(reversal.id);
  });
});
