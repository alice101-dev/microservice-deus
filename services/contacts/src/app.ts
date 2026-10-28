import {
  authentication,
  requireOrganization,
  type ServiceVerifier,
  serviceAuthentication,
  type Verifier,
} from "@deus/auth";
import type { BaseConfig } from "@deus/config";
import { type Database, isCheckViolation, withTenant } from "@deus/db";
import { NotFoundError, UnprocessableError } from "@deus/errors";
import { createService } from "@deus/http";
import type { Logger } from "@deus/logger";
import { and, asc, eq, ilike, inArray, type SQL } from "drizzle-orm";
import { t } from "elysia";
import { type Contact, contacts, type schema } from "./schema";

export interface ContactsContext {
  config: BaseConfig;
  logger: Logger;
  db: Database<typeof schema>;
  verify: Verifier;
  verifyService: ServiceVerifier;
  readiness?: Array<() => Promise<void>>;
}

export const LOOKUP_CALLERS = ["sales", "purchases", "payments", "notification", "reporting"] as const;

const Nullable = (schema: ReturnType<typeof t.String>) => t.Optional(t.Nullable(schema));
const ContactFields = {
  name: t.String({ minLength: 1, maxLength: 200 }),
  isCustomer: t.Boolean(),
  isVendor: t.Boolean(),
  email: Nullable(t.String({ format: "email", maxLength: 200 })),
  phone: Nullable(t.String({ pattern: "^[+0-9][0-9 ()-]{5,24}$" })),
  taxId: Nullable(t.String({ pattern: "^[0-9]{15,16}$" })),
  address: Nullable(t.String({ maxLength: 500 })),
  paymentTermsDays: t.Optional(t.Integer({ minimum: 0, maximum: 365 })),
};
const ContactView = t.Object({
  id: t.String(),
  name: t.String(),
  isCustomer: t.Boolean(),
  isVendor: t.Boolean(),
  email: t.Nullable(t.String()),
  phone: t.Nullable(t.String()),
  taxId: t.Nullable(t.String()),
  address: t.Nullable(t.String()),
  paymentTermsDays: t.Integer(),
  active: t.Boolean(),
});
const view = (contact: Contact) => ({
  id: contact.id,
  name: contact.name,
  isCustomer: contact.isCustomer,
  isVendor: contact.isVendor,
  email: contact.email,
  phone: contact.phone,
  taxId: contact.taxId,
  address: contact.address,
  paymentTermsDays: contact.paymentTermsDays,
  active: contact.active,
});
const Ids = t.Union([
  t.String({ format: "uuid" }),
  t.Array(t.String({ format: "uuid" }), { minItems: 1, maxItems: 200 }),
]);
const ROLE_REQUIRED = "A contact must be a customer, a vendor or both";
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (match) => `\\${match}`);

export function createApp(context: ContactsContext) {
  const { db } = context;
  return createService({ config: context.config, logger: context.logger, readiness: context.readiness })
    .group("/api/contacts", (api) =>
      api
        .use(authentication(context.verify))
        .get(
          "/",
          async ({ principal, query }) => {
            const conditions: SQL[] = [];
            if (query.role === "customer") conditions.push(eq(contacts.isCustomer, true));
            if (query.role === "vendor") conditions.push(eq(contacts.isVendor, true));
            if (query.q) conditions.push(ilike(contacts.name, `%${escapeLike(query.q)}%`));
            if (query.active !== undefined) conditions.push(eq(contacts.active, query.active));
            const rows = await withTenant(db, requireOrganization(principal), (tx) =>
              tx
                .select()
                .from(contacts)
                .where(and(...conditions))
                .orderBy(asc(contacts.name))
                .limit(500),
            );
            return rows.map(view);
          },
          {
            query: t.Object({
              role: t.Optional(t.Union([t.Literal("customer"), t.Literal("vendor")])),
              q: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
              active: t.Optional(t.Boolean()),
            }),
            response: t.Array(ContactView),
            detail: { summary: "Customers and vendors of the active organization, by name (at most 500)" },
          },
        )
        .post(
          "/",
          async ({ principal, body, set }) => {
            const organizationId = requireOrganization(principal);
            if (!body.isCustomer && !body.isVendor) throw new UnprocessableError(ROLE_REQUIRED);
            const [created] = await withTenant(db, organizationId, (tx) =>
              tx
                .insert(contacts)
                .values({
                  organizationId,
                  name: body.name,
                  isCustomer: body.isCustomer,
                  isVendor: body.isVendor,
                  email: body.email ?? null,
                  phone: body.phone ?? null,
                  taxId: body.taxId ?? null,
                  address: body.address ?? null,
                  paymentTermsDays: body.paymentTermsDays ?? 30,
                })
                .returning(),
            );
            set.status = 201;
            return view(created as Contact);
          },
          {
            body: t.Object(ContactFields),
            response: { 201: ContactView },
            detail: { summary: "Create a customer, a vendor or both" },
          },
        )
        .get(
          "/:id",
          async ({ principal, params }) => {
            const [contact] = await withTenant(db, requireOrganization(principal), (tx) =>
              tx.select().from(contacts).where(eq(contacts.id, params.id)),
            );
            if (!contact) throw new NotFoundError("The contact does not exist");
            return view(contact);
          },
          {
            params: t.Object({ id: t.String({ format: "uuid" }) }),
            response: ContactView,
            detail: { summary: "One contact" },
          },
        )
        .patch(
          "/:id",
          async ({ principal, params, body }) => {
            const [updated] = await withTenant(db, requireOrganization(principal), (tx) =>
              tx
                .update(contacts)
                .set({ ...body, updatedAt: new Date() })
                .where(eq(contacts.id, params.id))
                .returning(),
            ).catch((error: unknown) => {
              if (isCheckViolation(error)) throw new UnprocessableError(ROLE_REQUIRED, undefined, { cause: error });
              throw error;
            });
            if (!updated) throw new NotFoundError("The contact does not exist");
            return view(updated);
          },
          {
            params: t.Object({ id: t.String({ format: "uuid" }) }),
            body: t.Partial(t.Object({ ...ContactFields, active: t.Boolean() }), { minProperties: 1 }),
            response: ContactView,
            detail: { summary: "Update a contact" },
          },
        ),
    )
    .group("/internal/contacts", (internal) =>
      internal.use(serviceAuthentication(context.verifyService, LOOKUP_CALLERS)).get(
        "/lookup",
        async ({ query }) => {
          const rows = await withTenant(db, query.organizationId, (tx) =>
            tx
              .select()
              .from(contacts)
              .where(inArray(contacts.id, [query.id].flat())),
          );
          return rows.map(view);
        },
        {
          query: t.Object({ organizationId: t.String({ format: "uuid" }), id: Ids }),
          response: t.Array(ContactView),
          detail: { summary: "Contacts of an organization by id, for other services" },
        },
      ),
    );
}
