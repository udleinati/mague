import { z } from "zod";

export const adminCondominiumUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  designationType: z.enum(["building", "condominium"]).optional(),
  fiscalNumber: z.string().regex(/^\d{9}$/).nullable().optional(),
  email: z.string().email().max(255).nullable().optional(),
  // BCC para todos os emails enviados em nome do condomínio (exceto reset
  // de password). Aceita null (= limpar).
  bccEmail: z.string().email().max(255).nullable().optional(),
  // Reply-To para todos os emails do condomínio (exceto reset de password).
  // Aceita null (= limpar).
  replyToEmail: z.string().email().max(255).nullable().optional(),
  address: z.string().max(200).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  postalCode: z.string().regex(/^\d{4}-\d{3}$/).nullable().optional(),
  quotaDayOfMonth: z.number().int().min(1).max(31).optional(),
  // Nota livre da administração no topo do email de lembrete (ADR 0028).
  // Aceita null (= limpar).
  billingReminderNote: z.string().max(2000).nullable().optional(),
  // Equivalente para o email de lembrete de seguro. Aceita null (= limpar).
  insuranceReminderNote: z.string().max(2000).nullable().optional(),
  // Cutoff de conciliação - driver da view v_unit_balance (overdue) e
  // do banner do portal. Aceita null (limpar).
  reconciledThroughDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
