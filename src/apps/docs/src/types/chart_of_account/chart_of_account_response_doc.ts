import { z } from "@hono/zod-openapi";

export const ChartOfAccountResponseDoc = z.object({
  id: z.string().openapi({
    example: "global_expense_maintenance",
    description: 'ID global (prefixo "global_") ou nanoid(10) para custom',
  }),
  code: z.string().openapi({ example: "62" }),
  condominiumId: z.string().nullable().openapi({
    example: null,
    description: "null para contas globais; nanoid(6) para custom",
  }),
  isGlobal: z.boolean().openapi({ example: true }),
  name: z.string().openapi({ example: "Despesas de manutenção" }),
  type: z.string().openapi({ example: "expense" }),
  parentCode: z.string().nullable().openapi({ example: "6" }),
  description: z.string().nullable().openapi({ example: "Conservação das partes comuns" }),
  isActive: z.boolean().openapi({ example: true }),
  createdAt: z.string().openapi({ example: "2026-01-01T00:00:00Z" }),
  updatedAt: z.string().openapi({ example: "2026-01-01T00:00:00Z" }),
});

export const CreateChartOfAccountBodyDoc = z.object({
  code: z.string().min(1).max(20).openapi({ example: "62" }),
  name: z.string().min(1).max(150).openapi({ example: "Despesas de manutenção" }),
  type: z.enum(["asset", "liability", "equity", "revenue", "expense"]).openapi({
    example: "expense",
  }),
  parentCode: z.string().max(20).nullable().optional(),
  description: z.string().nullable().optional(),
});

export const UpdateChartOfAccountBodyDoc = CreateChartOfAccountBodyDoc.partial().extend({
  isActive: z.boolean().optional(),
});

export const CondominiumParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
});

export const CategoryParamsDoc = z.object({
  cid: z.string().openapi({ example: "MgX001" }),
  accountId: z.string().openapi({ example: "global_expense_maintenance" }),
});

export const ChartOfAccountListResponseDoc = z.object({
  data: z.array(ChartOfAccountResponseDoc),
});

export const ChartOfAccountResponseWrapperDoc = z.object({
  data: ChartOfAccountResponseDoc,
});

export { ErrorResponseDoc } from "$apps/docs/src/types/_common.ts";
