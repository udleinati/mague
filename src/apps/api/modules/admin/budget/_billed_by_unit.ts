// Soma real cobrada por fração de um budget (charges já geradas). Fonte única
// para o mapa de quotas pós-geração: o que está em finance.charge, não a
// previsão pro-rata da view. billed = Σ original_amount; periods = nº de
// competências distintas (meses no principal, prestações no suplementar).

import { and, eq, sql } from "drizzle-orm";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";

export interface BilledUnit {
  billed: number;
  periods: number;
}

export async function loadBilledByUnit(
  postgres: Postgres,
  budgetId: string,
): Promise<Map<string, BilledUnit>> {
  const rows = await postgres.query((db) =>
    db.select({
      unitId: schema.charge.unitId,
      billed: sql<string>`COALESCE(SUM(${schema.charge.originalAmount}), 0)`,
      periods: sql<string>`COUNT(DISTINCT ${schema.charge.competencePeriod})`,
    })
      .from(schema.charge)
      .where(and(
        eq(schema.charge.sourceType, "budget"),
        eq(schema.charge.sourceId, budgetId),
      ))
      .groupBy(schema.charge.unitId)
  );
  return new Map(
    rows
      .filter((r) => r.unitId !== null)
      .map((r) => [r.unitId as string, { billed: Number(r.billed), periods: Number(r.periods) }]),
  );
}
