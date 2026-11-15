import { z } from "zod";
import {
  ChargeKindSchema,
  ChargeNatureSchema,
  RecurringPaymentMethodSchema,
} from "$api/libs/enums.ts";

export const chargeCreateSchema = z.object({
  kind: ChargeKindSchema,
  /**
   * Natureza contabilística. Default `debit` (a receber / a pagar). `credit`
   * para receivables = crédito a favor da fração (auto-compensa dívidas
   * existentes ou futuras via trigger fn_charge_ai).
   */
  nature: ChargeNatureSchema.optional(),
  /**
   * Opcional. Se omitido, o handler infere a partir de `kind + supplierId`
   * (ver defaults.ts: inferChargeType). Permite override para casos especiais.
   */
  chargeType: z.string().min(1).max(40).optional(),
  description: z.string().min(1),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  /**
   * Opcional. Se omitido, derivado do `issueDate` (primeiro dia do mês).
   * Quando enviado, deve ser primeiro dia do mês (YYYY-MM-01) - sem isto os
   * reports mensais ficam enviesados.
   */
  competencePeriod: z.string().regex(/^\d{4}-\d{2}-01$/, {
    message: "competencePeriod deve ser primeiro dia do mês (YYYY-MM-01)",
  }).optional(),
  amountCents: z.number().int().positive(),
  unitId: z.string().nullable().optional(),
  supplierId: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  invoiceNumber: z.string().max(100).nullable().optional(),
  documentNumber: z.string().max(50).nullable().optional(),
  // Método de pagamento (snapshot na charge). Default 'manual'. Aplica-se
  // sobretudo a payable - quotas tipicamente herdam 'manual' do default.
  paymentMethod: RecurringPaymentMethodSchema.optional(),
  // Nota interna do admin (free-text). NUNCA exposta no portal.
  note: z.string().nullable().optional(),
});
/**
 * Update de campos inócuos + `amountCents`. Guardrails no handler: charge em
 * `open`/`overdue` com `settled_amount = 0`; alterar valor dispara o trigger
 * `fn_charge_amount_adjust_ledger`, bloqueado para quota/refacturation.
 */
export const chargeUpdateSchema = z.object({
  description: z.string().min(1).optional(),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  // Coerente com o create: tem de ser primeiro dia do mês. Se omitido no
  // body, o handler preserva o valor existente (não apaga). Não-nullable -
  // a coluna no DB é NOT NULL.
  competencePeriod: z.string().regex(/^\d{4}-\d{2}-01$/, {
    message: "competencePeriod deve ser primeiro dia do mês (YYYY-MM-01)",
  }).optional(),
  amountCents: z.number().int().positive().optional(),
  invoiceNumber: z.string().max(100).nullable().optional(),
  documentNumber: z.string().max(50).nullable().optional(),
  // Editar payment_method é permitido (admin pode reclassificar uma despesa
  // de manual para DD/TA depois de criar). Não dispara ledger.
  paymentMethod: RecurringPaymentMethodSchema.optional(),
  note: z.string().nullable().optional(),
});
export type ChargeUpdate = z.infer<typeof chargeUpdateSchema>;

export const refacturationBatchSchema = z.object({
  allocations: z.array(z.object({
    unitId: z.string().min(1),
    amountCents: z.number().int().positive(),
    description: z.string().min(1).optional(),
  })).min(1),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Obrigatório: refaturação sem vencimento nunca conta como dívida em atraso
  // (`v_unit_balance` e os lembretes exigem `due_date`) - ficava invisível.
  // Default da UI = último dia do mês seguinte.
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
    message: "dueDate obrigatório (YYYY-MM-DD)",
  }),
});
