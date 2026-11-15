import { z } from "@hono/zod-openapi";

export const BudgetResponseDoc = z.object({
  id: z.string().openapi({ example: "Bd9gt2KlM4", description: "nanoid(10)" }),
  condominiumId: z.string().openapi({ example: "MgX001", description: "nanoid(6)" }),
  year: z.string().openapi({ example: "2026" }),
  status: z.string().openapi({ example: "draft" }),
  notes: z.string().nullable().openapi({ example: "Orçamento para o ano de 2026" }),
  type: z.string().openapi({ example: "principal" }),
  parentBudgetId: z.string().nullable().openapi({ example: null }),
  fcrPercentage: z.string().nullable().openapi({ example: "10.00" }),
  approvedAt: z.string().nullable().openapi({ example: "2026-03-15T10:00:00Z" }),
  approvedBy: z.string().nullable().openapi({ example: "u_admin" }),
  createdAt: z.string().openapi({ example: "2026-01-01T00:00:00Z" }),
  updatedAt: z.string().openapi({ example: "2026-01-01T00:00:00Z" }),
  totalAmount: z.number().openapi({ example: 10000000 }),
  fcrAmount: z.number().openapi({ example: 1000000 }),
});

export const CreateBudgetBodyDoc = z.object({
  year: z.string().openapi({ example: "2026" }),
  notes: z.string().nullable().optional().openapi({ example: "Orçamento para o ano de 2026" }),
  fcrPercentage: z.string().nullable().optional().openapi({ example: "10.00" }),
  parentBudgetId: z.string().nullable().optional().openapi({ example: null }),
});

export const UpdateBudgetBodyDoc = z.object({
  notes: z.string().nullable().optional().openapi({ example: "Orçamento atualizado" }),
  fcrPercentage: z.string().nullable().optional().openapi({ example: "12.50" }),
});

export const BudgetParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  budgetId: z.string().openapi({ example: "Bd9gt2KlM4" }),
});

export const BudgetListResponseDoc = z.object({
  data: z.array(BudgetResponseDoc),
});

export const BudgetResponseWrapperDoc = z.object({
  data: BudgetResponseDoc,
});

export { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";
