// Schema Drizzle para `core.payment_plan` (plano de pagamento por fração,
// informativo + histórico). Ver ADR 0039.

import { date, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

// Enum espelhado como `as const` para Zod (libs/model/payment_plan.ts) e UI.
export const PAYMENT_PLAN_STATUSES = [
  "active",
  "completed",
  "broken",
  "cancelled",
] as const;
export type PaymentPlanStatus = (typeof PAYMENT_PLAN_STATUSES)[number];

// Estados terminais (fecham o plano - exigem ended_at, saem do "1 active").
export const PAYMENT_PLAN_TERMINAL_STATUSES = PAYMENT_PLAN_STATUSES.filter(
  (s) => s !== "active",
);

export const paymentPlan = schema.table("payment_plan", {
  id: text("id").default(sql`public.nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),
  unitId: text("unit_id").notNull(),

  status: varchar("status", { length: 20 }).default("active").notNull().$type<PaymentPlanStatus>(),

  // Nota partilhada (sai no email ao condómino) e interna (só admin).
  notes: text("notes"),
  internalNotes: text("internal_notes"),
  endDate: date("end_date"),
  endedAt: timestamp("ended_at", { withTimezone: true }),

  createdBy: actorColumn("created_by").notNull(),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
  deletedBy: actorColumn("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type PaymentPlanSelect = typeof paymentPlan.$inferSelect;
export type PaymentPlanInsert = typeof paymentPlan.$inferInsert;
export type PaymentPlanUpdate = Partial<PaymentPlanInsert>;
