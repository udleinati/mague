// Inputs da distribuição por permillage de um budget, partilhados pela geração
// (runQuotaGeneration) E pela previsão (computeQuotaPreview). Carregar daqui é o
// que garante que a previsão usa exatamente os mesmos números que a geração - se
// estas queries divergissem, a previsão voltaria a não bater com o cobrado.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbClient, TxClient } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";

export interface DistributionInputs {
  /** Σ annual_amount das budget_lines não apagadas (cêntimos). */
  totalAnnual: number;
  /** Σ permillage das frações ativas. */
  totalPm: number;
  /** Fração de maior permillage (absorve o diff de arredondamento). */
  bigUnitId: string | null;
  units: { id: string; permillage: number }[];
}

type Executor = DbClient | TxClient;

export async function loadDistributionInputs(
  db: Executor,
  condominiumId: string,
  budgetId: string,
): Promise<DistributionInputs> {
  const [pmAgg] = await db.select({
    totalPm: sql<string>`COALESCE(SUM(${schema.unit.permillage}::numeric), 0)`,
  }).from(schema.unit).where(and(
    eq(schema.unit.condominiumId, condominiumId),
    eq(schema.unit.isActive, true),
  ));

  const [bigUnit] = await db.select({ id: schema.unit.id })
    .from(schema.unit).where(and(
      eq(schema.unit.condominiumId, condominiumId),
      eq(schema.unit.isActive, true),
    )).orderBy(sql`${schema.unit.permillage}::numeric DESC`).limit(1);

  const [linesAgg] = await db.select({
    totalAnnual: sql<string>`COALESCE(SUM(${schema.budgetLine.annualAmount}), 0)`,
  }).from(schema.budgetLine).where(and(
    eq(schema.budgetLine.budgetId, budgetId),
    isNull(schema.budgetLine.deletedAt),
  ));

  const units = (await db.select({
    id: schema.unit.id,
    permillage: schema.unit.permillage,
  }).from(schema.unit).where(and(
    eq(schema.unit.condominiumId, condominiumId),
    eq(schema.unit.isActive, true),
  ))).map((u) => ({ id: u.id, permillage: Number(u.permillage) }));

  return {
    totalAnnual: Number(linesAgg.totalAnnual),
    totalPm: Number(pmAgg.totalPm),
    bigUnitId: bigUnit?.id ?? null,
    units,
  };
}
