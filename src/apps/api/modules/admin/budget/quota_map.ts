import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatBudgetQuotaMapForResponse } from "./_projection_quota_map.ts";
import { loadBilledByUnit } from "./_billed_by_unit.ts";
import { computeQuotaPreview } from "./quota_preview.ts";
import { unitNaturalOrder } from "$api/libs/postgres/order_by.ts";

// GET /budgets/:budgetId/quota_map
// Lê finance.v_budget_quota_map (012_view_budget_quota_map.sql). LEFT JOIN com
// core.unit para trazer o `identifier` (Bloco/Piso/Loja) - a view não o
// expõe.
export const getBudgetQuotaMap = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const budgetId = requireParam(ctx, "budgetId");

  // Enumeramos as colunas explicitamente em vez de `getTableColumns` porque
  // `budgetQuotaMap` é uma view (Drizzle só aceita Table aí).
  const rows = await postgres.query((db) =>
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
      // Ordem natural: A, B, …, Z, AA, AB, … (length asc + alfabético).
      .orderBy(...unitNaturalOrder(schema.budgetQuotaMap.unitDesignation))
  );

  if (rows.length === 0) {
    throw new AppError({
      message: "Orçamento não encontrado (ou sem linhas/frações)",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  // Valores por fração: cobrado real (charges) se já gerado; senão a previsão
  // pelo MESMO algoritmo da geração - igual ao que será cobrado, não muda ao gerar.
  const amountsByUnit = rows[0].quotasGeneratedAt != null
    ? await loadBilledByUnit(postgres, budgetId)
    : await computeQuotaPreview(postgres, condominiumId, budgetId);

  return ctx.json({ data: formatBudgetQuotaMapForResponse(rows, amountsByUnit) });
};
