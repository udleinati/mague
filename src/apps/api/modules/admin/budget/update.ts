import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { budgetUpdateSchema } from "$api/libs/model/budget.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { BUDGET_PROJECTION, formatBudgetForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const updateBudget = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const budgetId = requireParam(ctx, "budgetId");

  const body = await dtoValidator(budgetUpdateSchema, await ctx.req.json());

  const existing = await postgres.query((db) =>
    db.query.budget.findFirst({
      where: byIdInCondo(schema.budget, budgetId, condominiumId),
    })
  );
  const existingData = findEntityOrFail(existing, "Orçamento");

  if (existingData.status !== "draft") {
    throw new AppError({
      message: "Não é possível editar um orçamento já aprovado",
      statusCode: STATUS_CODE.Conflict,
      code: "CONFLICT",
    });
  }

  const updateRows = await postgres.query((db) =>
    db.update(schema.budget)
      .set({
        notes: body.notes !== undefined ? body.notes : existingData.notes,
        // Suplementar mantém FCR 0 (sem input); só o principal pode alterar.
        fcrPercentage: existingData.type === "suplementar"
          ? existingData.fcrPercentage
          : (body.fcrPercentage !== undefined ? body.fcrPercentage : existingData.fcrPercentage),
        // Nº de prestações só faz sentido no suplementar; principal fica NULL.
        installments: existingData.type === "suplementar" && body.installments !== undefined
          ? body.installments
          : existingData.installments,
        updatedAt: new Date(),
        updatedBy: requireActor(ctx),
      })
      .where(byIdInCondo(schema.budget, budgetId, condominiumId))
      .returning()
  );

  const updated = updateRows[0];
  if (!updated) {
    throw new AppError({
      message: "Orçamento não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  const full = await postgres.query((db) =>
    db.query.budget.findFirst({
      where: (e, ops) => ops.eq(e.id, updated.id),
      ...BUDGET_PROJECTION,
    })
  );
  if (!full) {
    return ctx.json({ data: formatBudgetForResponse(updated) }, STATUS_CODE.OK);
  }

  return ctx.json({ data: formatBudgetForResponse(full) }, STATUS_CODE.OK);
};
