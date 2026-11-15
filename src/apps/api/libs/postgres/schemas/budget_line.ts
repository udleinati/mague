import { integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

export const budgetLine = schema.table("budget_line", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  budgetId: text("budget_id").notNull(),
  accountId: text("account_id").notNull(),
  annualAmount: integer("annual_amount").default(0).notNull(),
  excludedUnitCategories: text("excluded_unit_categories").array(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
  deletedBy: actorColumn("deleted_by"),
});

export type BudgetLineSelect = typeof budgetLine.$inferSelect;
export type BudgetLineInsert = typeof budgetLine.$inferInsert;
export type BudgetLineUpdate = Partial<BudgetLineInsert>;
