import { jsonb, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

export interface InsuranceReminderRecipient {
  occupantId: string;
  email: string;
  name: string;
  status: "sent" | "failed";
  sentAt: string;
  error?: string;
}

export const insuranceReminder = schema.table("insurance_reminder", {
  id: text("id").default(sql`public.nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),
  unitId: text("unit_id").notNull(),
  trigger: varchar("trigger", { length: 20 }).notNull(),
  recipients: jsonb("recipients")
    .$type<InsuranceReminderRecipient[]>()
    .default(sql`'[]'::jsonb`)
    .notNull(),
  sentBy: actorColumn("sent_by").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
});

export type InsuranceReminderSelect = typeof insuranceReminder.$inferSelect;
export type InsuranceReminderInsert = typeof insuranceReminder.$inferInsert;
