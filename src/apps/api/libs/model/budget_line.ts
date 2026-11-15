import { z } from "zod";

export const budgetLineCreateSchema = z.object({
  accountId: z.string().min(1, "accountId é obrigatório"),
  annualAmount: z.number().int().min(0, "Montante deve ser um inteiro positivo"),
  notes: z.string().nullable().optional(),
});

export const budgetLineUpdateSchema = z.object({
  annualAmount: z.number().int().min(0).optional(),
  notes: z.string().nullable().optional(),
});

export type BudgetLineUpdate = z.infer<typeof budgetLineUpdateSchema>;
