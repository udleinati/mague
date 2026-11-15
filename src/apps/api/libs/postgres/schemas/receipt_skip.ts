import { jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { IssuedByActor } from "./receipt.ts";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("finance");

/**
 * Marca uma tupla (bank_transaction, unit) como ignorada da fila de recibos
 * pendentes. Retomar = soft-delete (volta a aparecer em vw_pending_receipts).
 */
export const receiptSkip = schema.table("receipt_skip", {
  id: text("id").default(sql`public.nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),
  bankTransactionId: text("bank_transaction_id").notNull(),
  unitId: text("unit_id").notNull(),

  reason: text("reason"),
  skippedBy: jsonb("skipped_by").$type<IssuedByActor>().notNull(),

  // Soft-delete = retomar. Active skip = deletedAt IS NULL.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: jsonb("deleted_by").$type<IssuedByActor | null>(),
  deletedReason: text("deleted_reason"),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
});

export type ReceiptSkipSelect = typeof receiptSkip.$inferSelect;
export type ReceiptSkipInsert = typeof receiptSkip.$inferInsert;
