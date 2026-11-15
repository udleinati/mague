// Projection partilhada dos settlements (padrão em charge/_projection.ts):
//   - `SETTLEMENT_PROJECTION` - top-level + nested debitCharge/creditCharge/
//     bankTransaction; poupa ao panel de conciliação listCharges + listBankTx.
//   - `formatSettlementForResponse` - whitelist + nested default `null`.

import type { SettlementSelect } from "$api/libs/postgres/schemas/settlement.ts";

const SETTLEMENT_TOP_LEVEL_COLUMNS = {
  id: true,
  condominiumId: true,
  unitId: true,
  settlementType: true,
  debitChargeId: true,
  creditChargeId: true,
  bankTransactionId: true,
  amount: true,
  settlementDate: true,
  status: true,
  reversedAt: true,
  reversalReason: true,
  notes: true,
  createdAt: true,
} as const;

const SETTLEMENT_NESTED_WITH = {
  debitCharge: {
    columns: {
      id: true,
      description: true,
      chargeType: true,
      unitId: true,
      supplierId: true,
      competencePeriod: true,
    },
  },
  creditCharge: {
    columns: {
      id: true,
      description: true,
      chargeType: true,
      unitId: true,
      supplierId: true,
      competencePeriod: true,
    },
  },
  bankTransaction: {
    columns: {
      id: true,
      transactionDate: true,
      description: true,
      amount: true,
      status: true,
    },
  },
} as const;

// `findMany`/`findFirst` config - espalha com `...SETTLEMENT_PROJECTION`.
export const SETTLEMENT_PROJECTION = {
  columns: SETTLEMENT_TOP_LEVEL_COLUMNS,
  with: SETTLEMENT_NESTED_WITH,
} as const;

// Tipos dos nested - derivados à mão (Drizzle não infere de config `as const`).
export type SettlementNestedCharge = {
  id: string;
  description: string;
  chargeType: string;
  unitId: string | null;
  supplierId: string | null;
  /** Date YYYY-MM-DD (dia 01 por convenção) - ao contrário da response de
   *  charge, aqui NÃO é truncado a YYYY-MM (vem direto da column). */
  competencePeriod: string | null;
} | null;

export type SettlementNestedBankTransaction = {
  id: string;
  transactionDate: string;
  description: string | null;
  amount: number;
  status: string | null;
} | null;

// Input flex: aceita rows com nested (vindos da query relational) OU sem
// (vindos de `.returning()` no insert/update).
type SettlementRowLike = Partial<SettlementSelect> & {
  debitCharge?: SettlementNestedCharge;
  creditCharge?: SettlementNestedCharge;
  bankTransaction?: SettlementNestedBankTransaction;
};

export function formatSettlementForResponse(row: SettlementRowLike) {
  return {
    id: row.id,
    condominiumId: row.condominiumId,
    unitId: row.unitId,
    settlementType: row.settlementType,
    debitChargeId: row.debitChargeId,
    creditChargeId: row.creditChargeId,
    bankTransactionId: row.bankTransactionId,
    amount: row.amount,
    settlementDate: row.settlementDate,
    status: row.status,
    reversedAt: row.reversedAt,
    reversalReason: row.reversalReason,
    notes: row.notes,
    createdAt: row.createdAt,
    // Nested (subset estável). `null` quando FK é null OU quando o handler
    // não pediu o `with`.
    debitCharge: row.debitCharge ?? null,
    creditCharge: row.creditCharge ?? null,
    bankTransaction: row.bankTransaction ?? null,
  };
}
