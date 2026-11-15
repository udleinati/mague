import { boolean, date, integer, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("finance");

export const bankTransaction = schema.table("bank_transaction", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  bankAccountId: text("bank_account_id").notNull(),
  condominiumId: text("condominium_id").notNull(),
  transactionDate: date("transaction_date").notNull(),
  valueDate: date("value_date"),
  amount: integer("amount").notNull(),
  description: text("description"),
  balanceAfter: integer("balance_after"),
  isReconciled: boolean("is_reconciled").default(false),
  importHash: varchar("import_hash", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  notes: text("notes"),
  importBatchId: text("import_batch_id"),
  operationDate: date("operation_date"),
  status: varchar("status", { length: 20 }).default("unreconciled"),
  matchStatus: varchar("match_status", { length: 20 }).default("pending"),
  // Reversão (devolução do banco ou conciliação errada). O handler
  // `bank_transaction/reverse.ts` cascateia settlements/charges/ledger/recibos. O
  // actor vem do audit trigger genérico - não há coluna `reversed_by` aqui.
  reversedByTransactionId: text("reversed_by_transaction_id"),
  reversalReason: text("reversal_reason"),
  // Reverse via reversed_by_transaction_id, sem soft-delete.
  createdBy: actorColumn("created_by"),
  updatedBy: actorColumn("updated_by"),
});

export type BankTransactionSelect = typeof bankTransaction.$inferSelect;
export type BankTransactionInsert = typeof bankTransaction.$inferInsert;
export type BankTransactionUpdate = Partial<BankTransactionInsert>;
