import {
  authentication,
  requireOrganization,
  type ServiceVerifier,
  serviceAuthentication,
  type Verifier,
} from "@deus/auth";
import type { AccountRef, Lookup } from "@deus/clients";
import type { BaseConfig } from "@deus/config";
import { type Database, isUniqueViolation, withTenant } from "@deus/db";
import { ConflictError, NotFoundError, UnprocessableError } from "@deus/errors";
import { createService } from "@deus/http";
import type { Logger } from "@deus/logger";
import { AMOUNT_PATTERN, normalize, RATE_PATTERN } from "@deus/money";
import { and, asc, eq, ilike, inArray, or, type SQL } from "drizzle-orm";
import { t } from "elysia";
import { type Product, products, type schema } from "./schema";

export interface ProductsContext {
  config: BaseConfig;
  logger: Logger;
  db: Database<typeof schema>;
  verify: Verifier;
  verifyService: ServiceVerifier;
  accounts: Lookup<AccountRef>;
  readiness?: Array<() => Promise<void>>;
}

export const LOOKUP_CALLERS = ["sales", "purchases"] as const;

const Amount = t.String({ pattern: AMOUNT_PATTERN });
const Rate = t.String({ pattern: RATE_PATTERN });
const Kind = t.Union([t.Literal("goods"), t.Literal("service")]);
const ProductFields = {
  sku: t.String({ pattern: "^[0-9A-Za-z][0-9A-Za-z._-]{0,39}$" }),
  name: t.String({ minLength: 1, maxLength: 200 }),
  kind: Kind,
  unit: t.Optional(t.String({ minLength: 1, maxLength: 20 })),
  salePrice: t.Optional(t.Nullable(Amount)),
  purchasePrice: t.Optional(t.Nullable(Amount)),
  vatRate: t.Optional(Rate),
  revenueAccountId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
  expenseAccountId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
};
const ProductView = t.Object({
  id: t.String(),
  sku: t.String(),
  name: t.String(),
  kind: Kind,
  unit: t.String(),
  salePrice: t.Nullable(t.String()),
  purchasePrice: t.Nullable(t.String()),
  vatRate: t.String(),
  revenueAccountId: t.Nullable(t.String()),
  expenseAccountId: t.Nullable(t.String()),
  active: t.Boolean(),
});
const view = (product: Product) => ({
  id: product.id,
  sku: product.sku,
  name: product.name,
  kind: product.kind,
  unit: product.unit,
  salePrice: product.salePrice,
  purchasePrice: product.purchasePrice,
  vatRate: product.vatRate,
  revenueAccountId: product.revenueAccountId,
  expenseAccountId: product.expenseAccountId,
  active: product.active,
});
const Ids = t.Union([
  t.String({ format: "uuid" }),
  t.Array(t.String({ format: "uuid" }), { minItems: 1, maxItems: 200 }),
]);
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (match) => `\\${match}`);
const EXPENSE_TYPES = new Set(["expense", "asset"]);

export function createApp(context: ProductsContext) {
  const { db } = context;

  const assertAccounts = async (
    organizationId: string,
    input: { revenueAccountId?: string | null; expenseAccountId?: string | null },
  ) => {
    const ids = [input.revenueAccountId, input.expenseAccountId].filter((id): id is string => Boolean(id));
    if (ids.length === 0) return;
    const found = new Map((await context.accounts(ids, organizationId)).map((account) => [account.id, account]));
    const check = (id: string | null | undefined, field: string, allowed: (type: string) => boolean) => {
      if (!id) return;
      const account = found.get(id);
      if (!account) throw new UnprocessableError(`The ${field} does not exist`, { field });
      if (!account.active || !account.postable) {
        throw new UnprocessableError(`The ${field} must be an active account without sub-accounts`, { field });
      }
      if (!allowed(account.type))
        throw new UnprocessableError(`The ${field} has the wrong type`, { field, type: account.type });
    };
    check(input.revenueAccountId, "revenueAccountId", (type) => type === "revenue");
    check(input.expenseAccountId, "expenseAccountId", (type) => EXPENSE_TYPES.has(type));
  };

  const amounts = (input: { salePrice?: string | null; purchasePrice?: string | null; vatRate?: string }) => ({
    ...(input.salePrice !== undefined
      ? { salePrice: input.salePrice === null ? null : normalize(input.salePrice) }
      : {}),
    ...(input.purchasePrice !== undefined
      ? { purchasePrice: input.purchasePrice === null ? null : normalize(input.purchasePrice) }
      : {}),
    ...(input.vatRate !== undefined ? { vatRate: Number(input.vatRate).toFixed(2) } : {}),
  });

  const conflict = (sku: string | undefined) => (error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError(`SKU ${sku} already exists`, undefined, { cause: error });
    throw error;
  };

  return createService({ config: context.config, logger: context.logger, readiness: context.readiness })
    .group("/api/products", (api) =>
      api
        .use(authentication(context.verify))
        .get(
          "/",
          async ({ principal, query }) => {
            const conditions: SQL[] = [];
            if (query.kind) conditions.push(eq(products.kind, query.kind));
            if (query.active !== undefined) conditions.push(eq(products.active, query.active));
            if (query.q) {
              const pattern = `%${escapeLike(query.q)}%`;
              conditions.push(or(ilike(products.name, pattern), ilike(products.sku, pattern)) as SQL);
            }
            const rows = await withTenant(db, requireOrganization(principal), (tx) =>
              tx
                .select()
                .from(products)
                .where(and(...conditions))
                .orderBy(asc(products.sku))
                .limit(500),
            );
            return rows.map(view);
          },
          {
            query: t.Object({
              kind: t.Optional(Kind),
              q: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
              active: t.Optional(t.Boolean()),
            }),
            response: t.Array(ProductView),
            detail: { summary: "Goods and services of the active organization, by SKU (at most 500)" },
          },
        )
        .post(
          "/",
          async ({ principal, body, set }) => {
            const organizationId = requireOrganization(principal);
            await assertAccounts(organizationId, body);
            const [created] = await withTenant(db, organizationId, (tx) =>
              tx
                .insert(products)
                .values({
                  organizationId,
                  sku: body.sku,
                  name: body.name,
                  kind: body.kind,
                  unit: body.unit ?? (body.kind === "service" ? "jam" : "pcs"),
                  revenueAccountId: body.revenueAccountId ?? null,
                  expenseAccountId: body.expenseAccountId ?? null,
                  ...amounts(body),
                })
                .returning(),
            ).catch(conflict(body.sku));
            set.status = 201;
            return view(created as Product);
          },
          { body: t.Object(ProductFields), response: { 201: ProductView }, detail: { summary: "Create a product" } },
        )
        .get(
          "/:id",
          async ({ principal, params }) => {
            const [product] = await withTenant(db, requireOrganization(principal), (tx) =>
              tx.select().from(products).where(eq(products.id, params.id)),
            );
            if (!product) throw new NotFoundError("The product does not exist");
            return view(product);
          },
          {
            params: t.Object({ id: t.String({ format: "uuid" }) }),
            response: ProductView,
            detail: { summary: "One product" },
          },
        )
        .patch(
          "/:id",
          async ({ principal, params, body }) => {
            const organizationId = requireOrganization(principal);
            await assertAccounts(organizationId, body);
            const { salePrice, purchasePrice, vatRate, ...rest } = body;
            const [updated] = await withTenant(db, organizationId, (tx) =>
              tx
                .update(products)
                .set({ ...rest, ...amounts({ salePrice, purchasePrice, vatRate }), updatedAt: new Date() })
                .where(eq(products.id, params.id))
                .returning(),
            ).catch(conflict(body.sku));
            if (!updated) throw new NotFoundError("The product does not exist");
            return view(updated);
          },
          {
            params: t.Object({ id: t.String({ format: "uuid" }) }),
            body: t.Partial(t.Object({ ...ProductFields, active: t.Boolean() }), { minProperties: 1 }),
            response: ProductView,
            detail: { summary: "Update a product" },
          },
        ),
    )
    .group("/internal/products", (internal) =>
      internal.use(serviceAuthentication(context.verifyService, LOOKUP_CALLERS)).get(
        "/lookup",
        async ({ query }) => {
          const rows = await withTenant(db, query.organizationId, (tx) =>
            tx
              .select()
              .from(products)
              .where(inArray(products.id, [query.id].flat())),
          );
          return rows.map(view);
        },
        {
          query: t.Object({ organizationId: t.String({ format: "uuid" }), id: Ids }),
          response: t.Array(ProductView),
          detail: { summary: "Products of an organization by id, for other services" },
        },
      ),
    );
}
