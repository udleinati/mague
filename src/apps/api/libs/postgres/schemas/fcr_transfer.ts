// Schema Drizzle para `finance.fcr_transfer` (transferência entre a bolsa
// ordinária e a bolsa FCR do condomínio).
// Append-only: sem updated_*/deleted_* - corrigir é lançar a inversa.

import { date, integer, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("finance");

// Enum espelhado como `as const` para Zod (libs/model/fcr_transfer.ts) e UI.
export const FCR_TRANSFER_DIRECTIONS = ["to_fcr", "to_ordinary"] as const;
export type FcrTransferDirection = (typeof FCR_TRANSFER_DIRECTIONS)[number];

export const fcrTransfer = schema.table("fcr_transfer", {
  id: text("id").default(sql`public.nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),

  direction: varchar("direction", { length: 12 }).notNull().$type<FcrTransferDirection>(),
  amountCents: integer("amount_cents").notNull(),
  transferDate: date("transfer_date").notNull(),
  reason: text("reason").notNull(),

  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type FcrTransferSelect = typeof fcrTransfer.$inferSelect;
export type FcrTransferInsert = typeof fcrTransfer.$inferInsert;
