import { boolean, date, integer, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

export const recurringTemplate = schema.table("recurring_template", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),
  kind: varchar("kind", { length: 20 }).notNull(), // receivable | payable
  description: varchar("description", { length: 255 }).notNull(),
  amount: integer("amount").notNull(),
  accountId: text("account_id"),
  supplierId: text("supplier_id"),
  contractId: text("contract_id"),
  unitId: text("unit_id"),
  intervalType: varchar("interval_type", { length: 20 }).notNull(),
  // 'manual' | 'direct_debit' | 'auto_transfer' - CHECK na BD.
  paymentMethod: varchar("payment_method", { length: 20 }).notNull().default("manual"),
  dayOfMonth: integer("day_of_month"),
  startDate: date("start_date").notNull(),
  endDate: date("end_date"),
  nextRunDate: date("next_run_date").notNull(),
  lastGeneratedAt: timestamp("last_generated_at", { withTimezone: true }),
  isActive: boolean("is_active").default(true).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
  deletedBy: actorColumn("deleted_by"),
});

export type RecurringTemplateSelect = typeof recurringTemplate.$inferSelect;
export type RecurringTemplateInsert = typeof recurringTemplate.$inferInsert;
export type RecurringTemplateUpdate = Partial<RecurringTemplateInsert>;
