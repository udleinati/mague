import { integer, pgSchema, text } from "drizzle-orm/pg-core";

const schema = pgSchema("finance");

// VIEW finance.v_bank_balance (ver components/016_vw_receipt_pending.sql)
// Agrega saldo bancário atual por condomínio, separado em ordinário (121)
// e FCR (122), computado a partir do ledger.
export const bankBalance = schema.view("v_bank_balance", {
  condominiumId: text("condominium_id").notNull(),
  ordinaryCents: integer("ordinary_cents").notNull(),
  fcrCents: integer("fcr_cents").notNull(),
  totalCents: integer("total_cents").notNull(),
}).existing();

export type BankBalanceRow = typeof bankBalance.$inferSelect;
