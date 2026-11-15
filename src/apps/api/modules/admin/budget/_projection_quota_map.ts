// Agrega a matriz unidade × valores de um budget numa resposta com cabeçalho +
// unidades + totais. As linhas (`rows`) vêm da view só para o ESQUELETO: lista
// de frações, designação, permillage, identifier (LEFT JOIN core.unit) e
// metadados. Os VALORES por fração vêm sempre de `amountsByUnit`, nunca das
// colunas de valor da view (que arredondavam base+FCR por fração e divergiam do
// cobrado). Esse mapa é:
//   - cobrado real (pós-geração): Σ original_amount das charges (loadBilledByUnit);
//   - previsão (pré-geração): mesmo algoritmo da geração (computeQuotaPreview).
// Em ambos: billed = total anual/obra por fração; periods = divisor. O monthly e
// o split base/FCR são reconstruídos com a fórmula do trigger
// (004_trg_financial.sql): base = round(total/(1+fcr/100)), fcr = total - base -
// por isso batem exatamente com o ledger (contas 721/723). A soma das frações =
// o que é (ou será) efetivamente cobrado.

import type { BudgetQuotaMapRow } from "$api/libs/postgres/schemas/budget_quota_map.ts";
import type { BilledUnit } from "./_billed_by_unit.ts";

// Só o esqueleto: a view dá a lista de frações + metadados; os valores por
// fração vêm de `amountsByUnit`. As colunas de valor da view (monthly*/annual*)
// são propositadamente ignoradas (arredondavam mal - ver bug do mapa de quotas).
type QuotaMapSkeletonRow =
  & Pick<
    BudgetQuotaMapRow,
    | "budgetId"
    | "year"
    | "budgetType"
    | "budgetStatus"
    | "quotasGeneratedAt"
    | "fcrPercentage"
    | "unitId"
    | "unitDesignation"
    | "unitPermillage"
    | "totalPermillage"
    | "annualOrdinary"
  >
  & { identifier: string | null };

export function formatBudgetQuotaMapForResponse(
  rows: QuotaMapSkeletonRow[],
  amountsByUnit: Map<string, BilledUnit>,
) {
  const [first] = rows;
  if (!first) return null;

  const fcrPct = Number(first.fcrPercentage);
  const generated = first.quotasGeneratedAt != null;

  const units = rows.map((r) => {
    const a = amountsByUnit.get(r.unitId);
    const billed = a?.billed ?? 0;
    const periods = a?.periods ?? 0;
    const monthlyTotal = periods > 0 ? Math.round(billed / periods) : 0;
    const monthlyBase = Math.round(monthlyTotal / (1 + fcrPct / 100));
    return {
      unitId: r.unitId,
      unitDesignation: r.unitDesignation,
      identifier: r.identifier ?? null,
      unitPermillage: Number(r.unitPermillage),
      monthlyBaseCents: monthlyBase,
      monthlyFcrCents: monthlyTotal - monthlyBase,
      monthlyTotalCents: monthlyTotal,
      annualTotalCents: billed,
    };
  });

  const periodsGenerated = generated
    ? [...amountsByUnit.values()].reduce((m, b) => Math.max(m, b.periods), 0)
    : 0;

  return {
    budgetId: first.budgetId,
    year: first.year,
    budgetType: first.budgetType,
    budgetStatus: first.budgetStatus,
    quotasGeneratedAt: first.quotasGeneratedAt,
    fromCharges: generated,
    periodsGenerated,
    fcrPercentage: fcrPct,
    totalPermillage: Number(first.totalPermillage),
    annualOrdinaryCents: first.annualOrdinary,
    units,
    totals: {
      monthlyBaseCents: units.reduce((s, u) => s + u.monthlyBaseCents, 0),
      monthlyFcrCents: units.reduce((s, u) => s + u.monthlyFcrCents, 0),
      monthlyTotalCents: units.reduce((s, u) => s + u.monthlyTotalCents, 0),
      annualTotalCents: units.reduce((s, u) => s + u.annualTotalCents, 0),
    },
  };
}
