// POST /budgets/:budgetId/generate_quotas
//
// Geração INCREMENTAL até uma `throughDate`. O algoritmo (distribuição por
// permillage, FCR split, idempotência por competence_period) vive em
// `quota_generator.ts` (TS, testável). Cada charge gerada chama applyAutoOffset.
//
// Body:
//   { throughDate: "YYYY-MM-DD" }   (opcional - default: fim do ano do budget)

import type { Context } from "hono";
import { z } from "zod";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { formatBudgetForResponse } from "./_projection.ts";
import { runQuotaGeneration } from "./quota_generator.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

const bodySchema = z.object({
  throughDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Suplementar: mês da 1ª prestação (YYYY-MM). Default no gerador: próximo mês.
  firstMonth: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional(),
  notes: z.string().nullable().optional(),
});

export const generateQuotas = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const budgetId = requireParam(ctx, "budgetId");

  let rawBody: unknown = {};
  try {
    rawBody = await ctx.req.json();
  } catch { /* sem body → defaults */ }
  const body = await dtoValidator(bodySchema, rawBody);

  const existing = await postgres.query((db) =>
    db.query.budget.findFirst({
      where: byIdInCondo(schema.budget, budgetId, condominiumId),
    })
  );
  const budget = findEntityOrFail(existing, "Orçamento");

  // Default throughDate: 31 de Dezembro do ano do budget.
  const budgetYear = Number(budget.year);
  const throughDate = body.throughDate ?? `${budgetYear}-12-31`;

  const result = await runQuotaGeneration({
    condominiumId,
    budgetId,
    throughDate,
    firstMonth: body.firstMonth,
    notes: body.notes ?? null,
    actor,
  }, postgres);

  // Refetch budget (quotas_generated_at pode ter sido atualizado).
  const refetched = await postgres.query((db) =>
    db.query.budget.findFirst({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, budgetId),
          ops.eq(e.condominiumId, condominiumId),
        ),
    })
  );

  const serialized = formatBudgetForResponse(refetched!);

  return ctx.json({
    data: {
      ...serialized,
      chargesCreated: result.chargesCreated,
      throughDate,
      crossesYear: result.crossesYear,
    },
  });
};
