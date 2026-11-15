// Projection partilhada pelos handlers de bank accounts (padrão de charge/_projection.ts):
// BANK_ACCOUNT_PROJECTION = whitelist de columns; formatBankAccountForResponse = whitelist + defaults.

import type { BankAccountSelect } from "$api/libs/postgres/schemas/bank_account.ts";

const BANK_ACCOUNT_TOP_LEVEL_COLUMNS = {
  id: true,
  condominiumId: true,
  bankName: true,
  iban: true,
  accountName: true,
  accountHolder: true,
  isQuotaPayment: true,
  kind: true,
  isActive: true,
  csvConfig: true,
  openingBalance: true,
  openingBalanceOrdinaryCents: true,
  openingBalanceFcrCents: true,
  openingBalanceDate: true,
  createdAt: true,
} as const;

export const BANK_ACCOUNT_PROJECTION = {
  columns: BANK_ACCOUNT_TOP_LEVEL_COLUMNS,
} as const;

type BankAccountRowLike = Partial<BankAccountSelect>;

export function formatBankAccountForResponse(row: BankAccountRowLike) {
  return {
    id: row.id,
    condominiumId: row.condominiumId,
    bankName: row.bankName,
    iban: row.iban,
    accountName: row.accountName,
    accountHolder: row.accountHolder ?? null,
    isQuotaPayment: row.isQuotaPayment ?? false,
    kind: row.kind ?? "bank",
    isActive: row.isActive,
    csvConfig: row.csvConfig ?? null,
    openingBalance: row.openingBalance,
    openingBalanceOrdinaryCents: row.openingBalanceOrdinaryCents,
    openingBalanceFcrCents: row.openingBalanceFcrCents,
    openingBalanceDate: row.openingBalanceDate,
    createdAt: row.createdAt,
  };
}
