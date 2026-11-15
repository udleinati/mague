import { z } from "zod";
import { BudgetTypeSchema } from "$api/libs/enums.ts";

export const budgetCreateSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).transform(String),
  type: BudgetTypeSchema.default("principal"),
  notes: z.string().nullable().optional(),
  fcrPercentage: z.string().regex(/^\d+(\.\d{1,2})?$/, "Percentagem inválida").nullable()
    .optional(),
  parentBudgetId: z.string().nullable().optional(),
  // Nº de prestações - obrigatório nos suplementares, ignorado nos principais.
  installments: z.coerce.number().int().min(1).max(120).nullable().optional(),
});

export const budgetUpdateSchema = z.object({
  notes: z.string().nullable().optional(),
  fcrPercentage: z.string().regex(/^\d+(\.\d{1,2})?$/, "Percentagem inválida").nullable()
    .optional(),
  installments: z.coerce.number().int().min(1).max(120).nullable().optional(),
});

export type BudgetUpdate = z.infer<typeof budgetUpdateSchema>;
