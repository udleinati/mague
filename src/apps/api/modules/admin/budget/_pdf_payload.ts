// Carrega os dados de um orçamento para render em PDF: corpo (rubricas) + mapa de
// quotas por fração + totais. Mesma fonte de valores que a página/PDF do orçamento:
// previsão pelo algoritmo da geração antes de gerar quotas, cobrado real (charges)
// depois. Partilhado por budget/pdf.ts (PDF do orçamento) e assembly/minutes_pdf.ts
// (anexos da ata), garantindo valores idênticos. Devolve null se o orçamento não
// existir/estiver apagado.

import { and, eq, isNull } from "drizzle-orm";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { unitNaturalOrder } from "$api/libs/postgres/order_by.ts";
import { BUDGET_PROJECTION, formatBudgetForResponse } from "./_projection.ts";
import { formatBudgetQuotaMapForResponse } from "./_projection_quota_map.ts";
import { loadBilledByUnit } from "./_billed_by_unit.ts";
import { computeQuotaPreview } from "./quota_preview.ts";

export interface BudgetPdfPayload {
  budget: ReturnType<typeof formatBudgetForResponse>;
  quotaMap: ReturnType<typeof formatBudgetQuotaMapForResponse>;
  grandTotal: number;
  installmentValue: number | null;
}

export async function loadBudgetPdfPayload(
  postgres: Postgres,
  condominiumId: string,
  budgetId: string,
): Promise<BudgetPdfPayload | null> {
  const budgetRow = await postgres.query((db) =>
    db.query.budget.findFirst({
      where: and(
        eq(schema.budget.id, budgetId),
        eq(schema.budget.condominiumId, condominiumId),
        isNull(schema.budget.deletedAt),
      ),
      ...BUDGET_PROJECTION,
    })
  );
  if (!budgetRow) return null;
  const budget = formatBudgetForResponse(budgetRow);

  // Mapa por fração (mesma fonte que quota_map.ts). null se sem linhas/frações.
  const mapRows = await postgres.query((db) =>
    db.select({
      budgetId: schema.budgetQuotaMap.budgetId,
      condominiumId: schema.budgetQuotaMap.condominiumId,
      year: schema.budgetQuotaMap.year,
      budgetType: schema.budgetQuotaMap.budgetType,
      budgetStatus: schema.budgetQuotaMap.budgetStatus,
      quotasGeneratedAt: schema.budgetQuotaMap.quotasGeneratedAt,
      fcrPercentage: schema.budgetQuotaMap.fcrPercentage,
      unitId: schema.budgetQuotaMap.unitId,
      unitDesignation: schema.budgetQuotaMap.unitDesignation,
      unitPermillage: schema.budgetQuotaMap.unitPermillage,
      totalPermillage: schema.budgetQuotaMap.totalPermillage,
      annualOrdinary: schema.budgetQuotaMap.annualOrdinary,
      identifier: schema.unit.identifier,
    })
      .from(schema.budgetQuotaMap)
      .leftJoin(schema.unit, eq(schema.unit.id, schema.budgetQuotaMap.unitId))
      .where(and(
        eq(schema.budgetQuotaMap.budgetId, budgetId),
        eq(schema.budgetQuotaMap.condominiumId, condominiumId),
      ))
      .orderBy(...unitNaturalOrder(schema.budgetQuotaMap.unitDesignation))
  );
  // Valores por fração: cobrado real (charges) se já gerado; senão a previsão
  // pelo MESMO algoritmo da geração - igual ao que será cobrado, não muda ao gerar.
  const quotaMap = mapRows.length === 0 ? null : formatBudgetQuotaMapForResponse(
    mapRows,
    mapRows[0].quotasGeneratedAt != null
      ? await loadBilledByUnit(postgres, budgetId)
      : await computeQuotaPreview(postgres, condominiumId, budgetId),
  );

  const grandTotal = budget.totalAmount + budget.fcrAmount;
  const installmentValue = budget.type === "suplementar" && budget.installments
    ? Math.round(grandTotal / budget.installments)
    : null;

  return { budget, quotaMap, grandTotal, installmentValue };
}
