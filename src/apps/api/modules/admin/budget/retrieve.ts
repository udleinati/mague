import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { BUDGET_PROJECTION, formatBudgetForResponse } from "./_projection.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { and, eq, isNull } from "drizzle-orm";

export const getBudget = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const budgetId = requireParam(ctx, "budgetId");

  const result = await postgres.query((db) =>
    db.query.budget.findFirst({
      where: and(
        eq(schema.budget.id, budgetId),
        eq(schema.budget.condominiumId, condominiumId),
        isNull(schema.budget.deletedAt),
      ),
      ...BUDGET_PROJECTION,
    })
  );

  if (!result) {
    throw new AppError({
      message: "Orçamento não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  return ctx.json({ data: formatBudgetForResponse(result) });
};
