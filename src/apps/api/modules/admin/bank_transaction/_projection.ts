// Projection partilhada pelos handlers de bank_transactions (padrão de charge/_projection.ts):
// BANK_TRANSACTION_PROJECTION = whitelist de columns (omite deletedAt);
// formatBankTransactionForResponse = whitelist final (sem audit cols).

import type { BankTransactionSelect } from "$api/libs/postgres/schemas/bank_transaction.ts";

const BANK_TRANSACTION_TOP_LEVEL_COLUMNS = {
  id: true,
  bankAccountId: true,
  condominiumId: true,
  transactionDate: true,
  valueDate: true,
  amount: true,
  description: true,
  balanceAfter: true,
  status: true,
  matchStatus: true,
  notes: true,
  createdAt: true,
  createdBy: true,
  updatedBy: true,
  deletedBy: true,
} as const;

export const BANK_TRANSACTION_PROJECTION = {
  columns: BANK_TRANSACTION_TOP_LEVEL_COLUMNS,
} as const;

type BankTransactionRowLike = Partial<BankTransactionSelect>;

export function formatBankTransactionForResponse(row: BankTransactionRowLike) {
  return {
    id: row.id,
    bankAccountId: row.bankAccountId,
    condominiumId: row.condominiumId,
    transactionDate: row.transactionDate,
    valueDate: row.valueDate,
    amount: row.amount,
    description: row.description,
    balanceAfter: row.balanceAfter,
    status: row.status,
    matchStatus: row.matchStatus,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}
