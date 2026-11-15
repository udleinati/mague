import { date, integer, numeric, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

export const budget = schema.table("budget", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),
  year: varchar("year", { length: 4 }).notNull(),
  status: varchar("status", { length: 20 }).default("draft"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  type: varchar("type", { length: 20 }).default("principal"),
  parentBudgetId: text("parent_budget_id"),
  fcrPercentage: numeric("fcr_percentage", { precision: 5, scale: 2 }).default("10.00"),
  // Nº de prestações (só suplementar; principal = NULL → ÷12 anual implícito).
  installments: integer("installments"),
  // Mês da 1ª prestação, gravado na 1ª geração (trava o calendário).
  firstCompetencePeriod: date("first_competence_period"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: text("approved_by"),
  quotasGeneratedAt: timestamp("quotas_generated_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: actorColumn("created_by"),
  updatedBy: actorColumn("updated_by"),
  deletedBy: actorColumn("deleted_by"),
});

export type BudgetSelect = typeof budget.$inferSelect;
export type BudgetInsert = typeof budget.$inferInsert;
export type BudgetUpdate = Partial<BudgetInsert>;
