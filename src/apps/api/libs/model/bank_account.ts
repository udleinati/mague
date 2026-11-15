import { z } from "zod";

// `kind`: 'bank' (real, alimentada por CSV) ou 'cash' (caixa de numerário,
// alimentada por inserção manual). Default 'bank' bate com o default da coluna
// na BD e mantém compat retroactiva.
export const bankAccountKindSchema = z.enum(["bank", "cash"]);

// Espelha o CHECK constraint `bank_account_quota_only_for_bank`:
// `is_quota_payment=true` só é válido se `kind=bank`. Erro mais útil aqui que
// 23514 da DB.
const quotaPaymentRefine = (data: { kind?: "bank" | "cash"; isQuotaPayment?: boolean }) =>
  !(data.isQuotaPayment === true && data.kind === "cash");
const quotaPaymentRefineMsg = {
  message: "Conta de caixa (numerário) não pode ser marcada como destino de quotas",
  path: ["isQuotaPayment"],
};

export const bankAccountCreateSchema = z.object({
  bankName: z.string().min(1).max(100),
  iban: z.string().max(34).nullable().optional(),
  accountName: z.string().max(255).nullable().optional(),
  accountHolder: z.string().max(255).nullable().optional(),
  isQuotaPayment: z.boolean().optional(),
  kind: bankAccountKindSchema.optional(),
  openingBalance: z.number().int().optional(),
  openingBalanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  csvConfig: z.record(z.string(), z.unknown()).nullable().optional(),
}).refine(quotaPaymentRefine, quotaPaymentRefineMsg);

export const bankAccountUpdateSchema = z.object({
  bankName: z.string().min(1).max(100).optional(),
  iban: z.string().max(34).nullable().optional(),
  accountName: z.string().max(255).nullable().optional(),
  accountHolder: z.string().max(255).nullable().optional(),
  isQuotaPayment: z.boolean().optional(),
  kind: bankAccountKindSchema.optional(),
  isActive: z.boolean().optional(),
  openingBalance: z.number().int().optional(),
  openingBalanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  csvConfig: z.record(z.string(), z.unknown()).nullable().optional(),
}).refine(quotaPaymentRefine, quotaPaymentRefineMsg);

export type BankAccountUpdate = z.infer<typeof bankAccountUpdateSchema>;
