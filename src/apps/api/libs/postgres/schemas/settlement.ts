import { date, integer, jsonb, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("finance");

export const settlement = schema.table("settlement", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),
  unitId: text("unit_id"),
  debitChargeId: text("debit_charge_id"),
  creditChargeId: text("credit_charge_id"),
  bankTransactionId: text("bank_transaction_id"),
  amount: integer("amount").notNull(),
  settlementDate: date("settlement_date").notNull(),
  status: varchar("status", { length: 20 }).default("active").notNull(),
  settlementType: varchar("settlement_type", { length: 30 }).notNull(),
  reversedBy: text("reversed_by"),
  reversedAt: timestamp("reversed_at", { withTimezone: true }),
  reversalReason: text("reversal_reason"),
  notes: text("notes").default("").notNull(),
  metadata: jsonb("metadata").default({}).notNull(),
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
  // Reverse via status='reversed', sem soft-delete.
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  debitRefType: text("debit_ref_type"),
  debitRefId: text("debit_ref_id"),
  creditRefType: text("credit_ref_type"),
  creditRefId: text("credit_ref_id"),
});

export type SettlementSelect = typeof settlement.$inferSelect;
export type SettlementInsert = typeof settlement.$inferInsert;
export type SettlementUpdate = Partial<SettlementInsert>;
