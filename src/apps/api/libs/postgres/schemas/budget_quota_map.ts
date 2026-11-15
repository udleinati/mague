import { integer, numeric, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";

const schema = pgSchema("finance");

// VIEW finance.v_budget_quota_map (ver components/012_view_budget_quota_map.sql)
// Mapeia quotas mensais/anuais por fração para cada orçamento.
export const budgetQuotaMap = schema.view("v_budget_quota_map", {
  budgetId: text("budget_id").notNull(),
  condominiumId: text("condominium_id").notNull(),
  year: integer("year").notNull(),
  budgetType: varchar("budget_type", { length: 20 }).notNull(),
  budgetStatus: varchar("budget_status", { length: 20 }).notNull(),
  quotasGeneratedAt: timestamp("quotas_generated_at", { withTimezone: true }),
  fcrPercentage: numeric("fcr_percentage", { precision: 6, scale: 2 }).notNull(),
  unitId: text("unit_id").notNull(),
  unitDesignation: varchar("unit_designation", { length: 50 }).notNull(),
  unitPermillage: numeric("unit_permillage", { precision: 8, scale: 3 }).notNull(),
  totalPermillage: numeric("total_permillage").notNull(),
  annualOrdinary: integer("annual_ordinary").notNull(),
  monthlyBaseCents: integer("monthly_base_cents").notNull(),
  monthlyFcrCents: integer("monthly_fcr_cents").notNull(),
  monthlyTotalCents: integer("monthly_total_cents").notNull(),
  annualTotalCents: integer("annual_total_cents").notNull(),
}).existing();

export type BudgetQuotaMapRow = typeof budgetQuotaMap.$inferSelect;
