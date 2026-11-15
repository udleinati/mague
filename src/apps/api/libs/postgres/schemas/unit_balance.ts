import { integer, pgSchema, text } from "drizzle-orm/pg-core";

const schema = pgSchema("finance");

// VIEW finance.v_unit_balance (ver components/016_vw_receipt_pending.sql)
// Agrega saldo em aberto por fração (dívida, crédito, atraso, net).
export const unitBalance = schema.view("v_unit_balance", {
  condominiumId: text("condominium_id").notNull(),
  unitId: text("unit_id").notNull(),
  openDebtCents: integer("open_debt_cents").notNull(),
  openCreditCents: integer("open_credit_cents").notNull(),
  overdueDebtCents: integer("overdue_debt_cents").notNull(),
  /** Saldo líquido: debt − credit. Positivo = deve; negativo = tem crédito. */
  netCents: integer("net_cents").notNull(),
}).existing();

export type UnitBalanceRow = typeof unitBalance.$inferSelect;
