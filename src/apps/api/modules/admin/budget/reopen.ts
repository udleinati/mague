import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { BUDGET_PROJECTION, formatBudgetForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

// not_approved -> draft. Desfaz a marcação manual (reject.ts).
export const reopenBudget = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const budgetId = requireParam(ctx, "budgetId");

  const existing = await postgres.query((db) =>
    db.query.budget.findFirst({
      where: byIdInCondo(schema.budget, budgetId, condominiumId),
    })
  );
  const budget = findEntityOrFail(existing, "Orçamento");

  if (budget.status !== "not_approved") {
    throw new AppError({
      message: "Só um orçamento não aprovado pode ser reaberto",
      statusCode: STATUS_CODE.Conflict,
      code: "CONFLICT",
    });
  }

  await postgres.query((db) =>
    db.update(schema.budget)
      .set({ status: "draft", updatedAt: new Date(), updatedBy: requireActor(ctx) })
      .where(byIdInCondo(schema.budget, budgetId, condominiumId))
  );

  const full = await postgres.query((db) =>
    db.query.budget.findFirst({
      where: byIdInCondo(schema.budget, budgetId, condominiumId),
      ...BUDGET_PROJECTION,
    })
  );
  return ctx.json({ data: formatBudgetForResponse(findEntityOrFail(full, "Orçamento")) });
};
