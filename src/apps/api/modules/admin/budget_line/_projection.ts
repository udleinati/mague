// Projection partilhada dos budget_lines (padrão em charge/_projection.ts).
// `formatBudgetLineForResponse` aceita `categoryName` opcional (de
// chartOfAccount.name, resolvido pelo handler).

import type { BudgetLineSelect } from "$api/libs/postgres/schemas/budget_line.ts";

const BUDGET_LINE_TOP_LEVEL_COLUMNS = {
  id: true,
  budgetId: true,
  accountId: true,
  annualAmount: true,
  notes: true,
  createdAt: true,
} as const;

export const BUDGET_LINE_PROJECTION = {
  columns: BUDGET_LINE_TOP_LEVEL_COLUMNS,
} as const;

type BudgetLineRowLike = Partial<BudgetLineSelect>;

export function formatBudgetLineForResponse(
  row: BudgetLineRowLike,
  opts: { categoryName?: string } = {},
) {
  return {
    id: row.id,
    budgetId: row.budgetId,
    accountId: row.accountId,
    annualAmount: row.annualAmount,
    notes: row.notes,
    categoryName: opts.categoryName,
    createdAt: row.createdAt,
  };
}
