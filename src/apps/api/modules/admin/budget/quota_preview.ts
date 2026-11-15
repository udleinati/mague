// Previsão por fração de um budget AINDA não gerado. Usa exatamente o mesmo
// algoritmo (distributeByPermillage) e os mesmos inputs (loadDistributionInputs)
// que runQuotaGeneration - por isso o valor previsto é igual ao que será
// efetivamente cobrado, e NÃO muda quando as quotas forem geradas.
//
// Devolve o mesmo shape de loadBilledByUnit (billed = total anual/obra por
// fração; periods = divisor: 12 no principal, nº de prestações no suplementar),
// para a projeção tratar previsão e cobrado real de forma idêntica.

import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { loadDistributionInputs } from "./_distribution_inputs.ts";
import {
  computeInstallmentAmounts,
  computeMonthlyWithFcr,
  distributeByPermillage,
} from "./quota_distribution.ts";
import type { BilledUnit } from "./_billed_by_unit.ts";

export async function computeQuotaPreview(
  postgres: Postgres,
  condominiumId: string,
  budgetId: string,
): Promise<Map<string, BilledUnit>> {
  return await postgres.query(async (db) => {
    const [budget] = await db.select({
      type: schema.budget.type,
      fcrPercentage: schema.budget.fcrPercentage,
      installments: schema.budget.installments,
    }).from(schema.budget).where(and(
      eq(schema.budget.id, budgetId),
      eq(schema.budget.condominiumId, condominiumId),
      isNull(schema.budget.deletedAt),
    ));

    const result = new Map<string, BilledUnit>();
    if (!budget) return result;

    const { totalAnnual, totalPm, bigUnitId, units } = await loadDistributionInputs(
      db,
      condominiumId,
      budgetId,
    );
    if (totalAnnual <= 0 || totalPm <= 0 || units.length === 0) return result;

    const fcrPct = Number(budget.fcrPercentage);

    if (budget.type === "suplementar") {
      const n = budget.installments ?? 0;
      if (n < 1) return result;
      for (const u of units) result.set(u.id, { billed: 0, periods: n });
      // Soma as N prestações por fração (a última absorve o resto, como na geração).
      for (const amount of computeInstallmentAmounts(totalAnnual, fcrPct, n)) {
        for (
          const [unitId, cents] of distributeByPermillage(amount, amount, units, totalPm, bigUnitId)
        ) {
          result.get(unitId)!.billed += cents;
        }
      }
    } else {
      const monthly = computeMonthlyWithFcr(totalAnnual, fcrPct);
      const dist = distributeByPermillage(
        monthly.value,
        monthly.rounded,
        units,
        totalPm,
        bigUnitId,
      );
      for (const u of units) {
        result.set(u.id, { billed: (dist.get(u.id) ?? 0) * 12, periods: 12 });
      }
    }
    return result;
  });
}
