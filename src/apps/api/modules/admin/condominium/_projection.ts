// Projection partilhada pelos handlers de condominiums (ver charge/_projection.ts).

import type { CondominiumSelect } from "$api/libs/postgres/schemas/condominium.ts";

// Saldo bancário agregado (view `v_bank_balance`); ausente = zeros.
export interface BankBalance {
  ordinaryCents: number;
  fcrCents: number;
  totalCents: number;
}

const CONDOMINIUM_TOP_LEVEL_COLUMNS = {
  id: true,
  name: true,
  designationType: true,
  fiscalNumber: true,
  email: true,
  bccEmail: true,
  replyToEmail: true,
  address: true,
  city: true,
  postalCode: true,
  quotaDayOfMonth: true,
  billingReminderNote: true,
  insuranceReminderNote: true,
  reconciledThroughDate: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const CONDOMINIUM_PROJECTION = {
  columns: CONDOMINIUM_TOP_LEVEL_COLUMNS,
} as const;

type CondominiumRowLike = Partial<CondominiumSelect>;

export function formatCondominiumForResponse(
  row: CondominiumRowLike,
  opts: { bankBalance?: BankBalance } = {},
) {
  return {
    id: row.id,
    name: row.name,
    designationType: row.designationType ?? "condominium",
    fiscalNumber: row.fiscalNumber,
    email: row.email ?? null,
    bccEmail: row.bccEmail ?? null,
    replyToEmail: row.replyToEmail ?? null,
    address: row.address,
    city: row.city,
    postalCode: row.postalCode,
    quotaDayOfMonth: row.quotaDayOfMonth,
    billingReminderNote: row.billingReminderNote ?? null,
    insuranceReminderNote: row.insuranceReminderNote ?? null,
    reconciledThroughDate: row.reconciledThroughDate ?? null,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    bankBalance: opts.bankBalance ?? {
      ordinaryCents: 0,
      fcrCents: 0,
      totalCents: 0,
    },
  };
}
