// Schema Drizzle para `core.billing_reminder` (ADR 0028).
// Espelha `insurance_reminder.ts` - 1 row por (cond × fração × envio) com
// `recipients[]` JSONB de status por destinatário.

import { jsonb, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

export interface BillingReminderRecipient {
  occupantId: string;
  email: string;
  name: string;
  status: "sent" | "failed";
  sentAt: string;
  error?: string;
}

export const billingReminder = schema.table("billing_reminder", {
  id: text("id").default(sql`public.nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),
  unitId: text("unit_id").notNull(),
  // "individual" (1 botão por fração) ou "bulk" (botão "Enviar a todas").
  // CHECK constraint enforced em SQL.
  trigger: varchar("trigger", { length: 10 }).notNull(),
  recipients: jsonb("recipients")
    .$type<BillingReminderRecipient[]>()
    .default(sql`'[]'::jsonb`)
    .notNull(),
  sentBy: actorColumn("sent_by").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
});

export type BillingReminderSelect = typeof billingReminder.$inferSelect;
export type BillingReminderInsert = typeof billingReminder.$inferInsert;
