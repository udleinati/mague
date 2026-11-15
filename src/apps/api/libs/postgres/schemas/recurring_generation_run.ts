import { date, integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

// Append-only - uma row por execução do generator de recurring templates.
// O actor segue a convenção do ADR 0011 (JSONB).
export const recurringGenerationRun = schema.table("recurring_generation_run", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),
  throughDate: date("through_date").notNull(),
  templatesGenerated: integer("templates_generated").default(0).notNull(),
  chargesCreated: integer("charges_created").default(0).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: actorColumn("created_by").notNull(),
});

export type RecurringGenerationRunSelect = typeof recurringGenerationRun.$inferSelect;
export type RecurringGenerationRunInsert = typeof recurringGenerationRun.$inferInsert;
