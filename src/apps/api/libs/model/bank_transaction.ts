import { z } from "zod";
import { SettlementTypeSchema } from "$api/libs/enums.ts";

export const bankTransactionCreateSchema = z.object({
  bankAccountId: z.string(),
  transactionDate: z.string().date(),
  valueDate: z.string().date().nullable().optional(),
  amount: z.number().int(), // pode ser negativo
  description: z.string().nullable().optional(),
  balanceAfter: z.number().int().nullable().optional(),
  importHash: z.string().max(64).nullable().optional(),
  notes: z.string().nullable().optional(),
});

// Criar settlement (conciliação manual).
// NOTA: o SETTLEMENT_TYPES canónico inclui também `bank_deposit_credit`,
// mas o create manual pelo endpoint admin aceita apenas os
// dois primeiros - `bank_deposit_credit` é gerado internamente pelo handler
// `executeAllocation` (TS) quando há excedente. Restringimos aqui.
const settlementTypeEnum = SettlementTypeSchema.exclude(["bank_deposit_credit"]);

export const settlementCreateSchema = z.object({
  settlementType: settlementTypeEnum,
  debitChargeId: z.string().nullable().optional(),
  creditChargeId: z.string().nullable().optional(),
  bankTransactionId: z.string().nullable().optional(),
  amount: z.number().int().positive(),
  settlementDate: z.string().date(),
  notes: z.string().optional(),
});
