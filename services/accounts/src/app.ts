import { authentication, type Principal, requireOrganization, type Verifier } from "@deus/auth";
import type { BaseConfig } from "@deus/config";
import { type Database, isUniqueViolation, withTenant } from "@deus/db";
import { ConflictError, NotFoundError, UnprocessableError } from "@deus/errors";
import { createService } from "@deus/http";
import type { Logger } from "@deus/logger";
import { and, asc, eq, inArray } from "drizzle-orm";
import { t } from "elysia";
import { DEFAULT_CHART } from "./defaults";
import { ACCOUNT_TYPES, type Account, accounts, type schema } from "./schema";

export interface AccountsContext {
  config: BaseConfig;
  logger: Logger;
  db: Database<typeof schema>;
  verify: Verifier;
  readiness?: Array<() => Promise<void>>;
}

const AccountType = t.UnionEnum([...ACCOUNT_TYPES]);
const AccountView = t.Object({
  id: t.String(),
  code: t.String(),
  name: t.String(),
  type: AccountType,
  parentId: t.Nullable(t.String()),
  active: t.Boolean(),
});
const view = (account: Account) => ({
  id: account.id,
  code: account.code,
  name: account.name,
  type: account.type,
  parentId: account.parentId,
  active: account.active,
});
const Code = t.String({ pattern: "^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$" });

export function createApp(context: AccountsContext) {
  const { db } = context;
  const tenant = <T>(principal: Principal, work: Parameters<typeof withTenant<typeof schema, T>>[2]) =>
    withTenant(db, requireOrganization(principal), work);

  return createService({ config: context.config, logger: context.logger, readiness: context.readiness }).group(
    "/api/accounts",
    (api) =>
      api
        .use(authentication(context.verify))
        .get(
          "/",
          async ({ principal }) => {
            const rows = await tenant(principal, (tx) => tx.select().from(accounts).orderBy(asc(accounts.code)));
            return rows.map(view);
          },
          { response: t.Array(AccountView), detail: { summary: "Chart of accounts of the active organization" } },
        )
        .post(
          "/",
          async ({ principal, body, set }) => {
            const organizationId = requireOrganization(principal);
            try {
              const [created] = await tenant(principal, async (tx) => {
                if (body.parentId) {
                  const [parent] = await tx.select().from(accounts).where(eq(accounts.id, body.parentId));
                  if (!parent) throw new UnprocessableError("The parent account does not exist");
                  if (parent.type !== body.type)
                    throw new UnprocessableError("A sub-account must have the type of its parent");
                }
                return tx
                  .insert(accounts)
                  .values({
                    organizationId,
                    code: body.code,
                    name: body.name,
                    type: body.type,
                    parentId: body.parentId ?? null,
                  })
                  .returning();
              });
              set.status = 201;
              return view(created as Account);
            } catch (error) {
              if (isUniqueViolation(error)) throw new ConflictError(`Account code ${body.code} already exists`);
              throw error;
            }
          },
          {
            body: t.Object({
              code: Code,
              name: t.String({ minLength: 1, maxLength: 120 }),
              type: AccountType,
              parentId: t.Optional(t.String({ format: "uuid" })),
            }),
            response: { 201: AccountView },
            detail: { summary: "Create an account" },
          },
        )
        .patch(
          "/:id",
          async ({ principal, params, body }) => {
            const [updated] = await tenant(principal, (tx) =>
              tx
                .update(accounts)
                .set({ ...body, updatedAt: new Date() })
                .where(eq(accounts.id, params.id))
                .returning(),
            );
            if (!updated) throw new NotFoundError("The account does not exist");
            return view(updated);
          },
          {
            params: t.Object({ id: t.String({ format: "uuid" }) }),
            body: t.Object(
              { name: t.Optional(t.String({ minLength: 1, maxLength: 120 })), active: t.Optional(t.Boolean()) },
              { minProperties: 1 },
            ),
            response: AccountView,
            detail: { summary: "Rename or (de)activate an account" },
          },
        )
        .post(
          "/defaults",
          async ({ principal, set }) => {
            const organizationId = requireOrganization(principal);
            const created = await tenant(principal, async (tx) => {
              const existing = await tx.select({ id: accounts.id }).from(accounts).limit(1);
              if (existing.length > 0) throw new ConflictError("The organization already has accounts");
              const ids = new Map<string, string>();
              const rows: Account[] = [];
              for (const entry of DEFAULT_CHART) {
                const [row] = await tx
                  .insert(accounts)
                  .values({
                    organizationId,
                    code: entry.code,
                    name: entry.name,
                    type: entry.type,
                    parentId: entry.parent ? (ids.get(entry.parent) ?? null) : null,
                  })
                  .returning();
                if (row) {
                  ids.set(entry.code, row.id);
                  rows.push(row);
                }
              }
              return rows;
            });
            set.status = 201;
            return created.map(view);
          },
          {
            response: { 201: t.Array(AccountView) },
            detail: { summary: "Create the default Indonesian SME chart of accounts" },
          },
        )
        .get(
          "/lookup",
          async ({ principal, query }) => {
            const ids = [query.id].flat();
            const rows = await tenant(principal, (tx) =>
              tx
                .select()
                .from(accounts)
                .where(and(inArray(accounts.id, ids))),
            );
            return rows.map(view);
          },
          {
            query: t.Object({
              id: t.Union([
                t.String({ format: "uuid" }),
                t.Array(t.String({ format: "uuid" }), { minItems: 1, maxItems: 200 }),
              ]),
            }),
            response: t.Array(AccountView),
            detail: { summary: "Accounts by id, for other services" },
          },
        ),
  );
}
