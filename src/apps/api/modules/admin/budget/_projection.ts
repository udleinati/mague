// Projection partilhada dos budgets (padrão em charge/_projection.ts):
//   - `BUDGET_PROJECTION` - top-level + nested budgetLines (com chartOfAccount).
//   - `formatBudgetForResponse` - whitelist + agrega totalAmount/fcrAmount;
//     lines ordenadas por code numérico ("5.1.2" antes de "5.1.10").

import type { BudgetSelect } from "$api/libs/postgres/schemas/budget.ts";
import type { BudgetLineSelect } from "$api/libs/postgres/schemas/budget_line.ts";
import type { ChartOfAccountSelect } from "$api/libs/postgres/schemas/chart_of_account.ts";

const BUDGET_TOP_LEVEL_COLUMNS = {
  id: true,
  condominiumId: true,
  year: true,
  status: true,
  notes: true,
  type: true,
  parentBudgetId: true,
  fcrPercentage: true,
  installments: true,
  firstCompetencePeriod: true,
  approvedAt: true,
  approvedBy: true,
  quotasGeneratedAt: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  updatedBy: true,
  deletedBy: true,
} as const;

const BUDGET_NESTED_WITH = {
  budgetLines: {
    with: {
      chartOfAccount: true,
    },
  },
} as const;

// `findMany`/`findFirst` config - espalha com `...BUDGET_PROJECTION`.
export const BUDGET_PROJECTION = {
  columns: BUDGET_TOP_LEVEL_COLUMNS,
  with: BUDGET_NESTED_WITH,
} as const;

// Input flex: aceita rows com budgetLines (vindos da query relational) OU
// sem (vindos de `.returning()` no insert/update).
type BudgetRowLike = Partial<BudgetSelect> & {
  budgetLines?: (BudgetLineSelect & { chartOfAccount?: ChartOfAccountSelect })[];
};

export function formatBudgetForResponse(row: BudgetRowLike) {
  const lines = (row.budgetLines ?? [])
    .filter((l) => !l.deletedAt)
    .map((l) => ({
      id: l.id,
      budgetId: l.budgetId,
      accountId: l.accountId,
      annualAmount: l.annualAmount,
      notes: l.notes,
      categoryName: l.chartOfAccount?.name ?? null,
      categoryCode: l.chartOfAccount?.code ?? null,
      categoryDescription: l.chartOfAccount?.description ?? null,
      createdAt: l.createdAt,
    }));

  // Ordenar pelo código da categoria. Segmentos numéricos comparados como
  // números (5.1.2 antes de 5.1.10), letra-a-letra para o resto. Linhas sem
  // code vão para o fim - `null` cai para "" depois de `?? ""`.
  lines.sort((a, b) => {
    if (!a.categoryCode && !b.categoryCode) return 0;
    if (!a.categoryCode) return 1;
    if (!b.categoryCode) return -1;
    const segA = a.categoryCode.split(".");
    const segB = b.categoryCode.split(".");
    for (let i = 0; i < Math.max(segA.length, segB.length); i++) {
      const pa = segA[i] ?? "";
      const pb = segB[i] ?? "";
      const na = Number(pa);
      const nb = Number(pb);
      if (!Number.isNaN(na) && !Number.isNaN(nb) && pa !== "" && pb !== "") {
        if (na !== nb) return na - nb;
      } else if (pa !== pb) {
        return pa.localeCompare(pb, "pt");
      }
    }
    return 0;
  });

  const totalAmount = lines.reduce((sum, l) => sum + (l.annualAmount ?? 0), 0);
  const fcrPct = parseFloat(String(row.fcrPercentage ?? "10"));
  const fcrAmount = Math.round((totalAmount * fcrPct) / 100);

  return {
    id: row.id,
    condominiumId: row.condominiumId,
    year: String(row.year ?? ""),
    status: row.status,
    notes: row.notes,
    type: row.type,
    parentBudgetId: row.parentBudgetId,
    fcrPercentage: row.fcrPercentage,
    installments: row.installments ?? null,
    firstCompetencePeriod: row.firstCompetencePeriod ?? null,
    approvedAt: row.approvedAt,
    approvedBy: row.approvedBy,
    quotasGeneratedAt: row.quotasGeneratedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    totalAmount,
    fcrAmount,
    lines,
  };
}
