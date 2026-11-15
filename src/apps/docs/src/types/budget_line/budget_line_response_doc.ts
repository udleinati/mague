import { z } from "@hono/zod-openapi";

export const BudgetLineResponseDoc = z.object({
  id: z.string().openapi({ example: "Ln3E2xY7zQ", description: "nanoid(10)" }),
  budgetId: z.string().openapi({ example: "Bd9gt2KlM4" }),
  accountId: z.string().openapi({
    example: "global_expense_maintenance",
    description: "ID do plano de contas (pode ser global ou nanoid custom)",
  }),
  annualAmount: z.number().openapi({ example: 5000000, description: "Valor em cêntimos" }),
  notes: z.string().nullable().openapi({ example: "Despesa anual" }),
  categoryName: z.string().openapi({ example: "Manutenção" }),
  createdAt: z.string().openapi({ example: "2026-01-01T00:00:00Z" }),
});

export const CreateBudgetLineBodyDoc = z.object({
  accountId: z.string().min(1).openapi({ example: "global_expense_maintenance" }),
  annualAmount: z.number().int().min(0).openapi({ example: 5000000 }),
  notes: z.string().nullable().optional().openapi({ example: "Despesa anual" }),
});

export const UpdateBudgetLineBodyDoc = z.object({
  annualAmount: z.number().int().min(0).optional().openapi({ example: 6000000 }),
  notes: z.string().nullable().optional().openapi({ example: "Despesa anual atualizada" }),
});

export const BudgetLineParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  budgetId: z.string().openapi({ example: "Bd9gt2KlM4" }),
  lineId: z.string().openapi({ example: "Ln3E2xY7zQ" }),
});

export const BudgetLineListResponseDoc = z.object({
  data: z.array(BudgetLineResponseDoc),
});

export const BudgetLineResponseWrapperDoc = z.object({
  data: BudgetLineResponseDoc,
});

export { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";
