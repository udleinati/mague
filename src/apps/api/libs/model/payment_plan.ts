// Espelha enums e regras do schema Drizzle de payment_plan. Ver ADR 0039.

import { z } from "zod";
import { PAYMENT_PLAN_STATUSES } from "$api/libs/postgres/schemas/payment_plan.ts";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "data deve ser YYYY-MM-DD");

// Texto vazio (ou só espaços) conta como "sem nota" e grava NULL.
const note = z.string().trim().max(2000).transform((v) => v === "" ? null : v)
  .nullable().optional();

/** Um plano precisa de pelo menos uma nota, partilhada ou interna. */
export function hasPaymentPlanNote(
  plan: { notes?: string | null; internalNotes?: string | null },
): boolean {
  return Boolean(plan.notes?.trim() || plan.internalNotes?.trim());
}

export const PAYMENT_PLAN_NOTE_REQUIRED =
  "Preenche pelo menos uma das notas (partilhada ou interna).";

export const paymentPlanCreateSchema = z.object({
  // `notes` = nota partilhada (sai no email); `internalNotes` = só a administração.
  notes: note,
  internalNotes: note,
  endDate: isoDate.nullable().optional(),
}).refine(hasPaymentPlanNote, { message: PAYMENT_PLAN_NOTE_REQUIRED, path: ["notes"] });

// Sem refine: o "pelo menos uma nota" valida-se no handler, sobre o plano já
// combinado com o que está gravado.
export const paymentPlanUpdateSchema = z.object({
  notes: note,
  internalNotes: note,
  endDate: isoDate.nullable().optional(),
  // Transição de estado (active -> completed/broken/cancelled). O handler
  // gere `ended_at` consoante a transição.
  status: z.enum(PAYMENT_PLAN_STATUSES).optional(),
});

export type PaymentPlanUpdate = z.infer<typeof paymentPlanUpdateSchema>;
