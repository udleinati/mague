import { date, integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

// Append-only por design - uma row por geração de quotas. Não tem
// `triggered_by/at` (redundantes com `created_at`); o actor
// é JSONB canónico em `created_by` (ver ADR 0011).
export const quotaGenerationRun = schema.table("quota_generation_run", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),
  budgetId: text("budget_id").notNull(),
  throughDate: date("through_date").notNull(),
  chargesCreated: integer("charges_created").default(0).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: actorColumn("created_by").notNull(),
});
