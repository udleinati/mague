import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { budgetLineUpdateSchema } from "$api/libs/model/budget_line.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatBudgetLineForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const updateBudgetLine = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const budgetId = ctx.req.param("budgetId");
  const lineId = ctx.req.param("lineId");

  if (!budgetId || !lineId) {
    throw new AppError({
      message: "budgetId e lineId são obrigatórios",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const budgetResult = await postgres.query((db) =>
    db.query.budget.findFirst({
      where: byIdInCondo(schema.budget, budgetId, condominiumId),
    })
  );
  const budget = findEntityOrFail(budgetResult, "Orçamento");

  if (budget.status !== "draft") {
    throw new AppError({
      message: "Não é possível editar linhas de um orçamento já aprovado",
      statusCode: STATUS_CODE.Conflict,
      code: "CONFLICT",
    });
  }

  const body = await dtoValidator(budgetLineUpdateSchema, await ctx.req.json());

  const existingResult = await postgres.query((db) =>
    db.query.budgetLine.findFirst({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, lineId),
          ops.eq(e.budgetId, budgetId),
          ops.isNull(e.deletedAt),
        ),
    })
  );
  const existing = findEntityOrFail(existingResult, "Linha");

  const updateRows = await postgres.query((db) =>
    db.update(schema.budgetLine)
      .set({
        annualAmount: body.annualAmount ?? existing.annualAmount,
        notes: body.notes !== undefined ? body.notes : existing.notes,
        updatedBy: actor,
      })
      .where(and(
        eq(schema.budgetLine.id, lineId),
        eq(schema.budgetLine.budgetId, budgetId),
        isNull(schema.budgetLine.deletedAt),
      ))
      .returning()
  );

  const updated = updateRows[0];
  if (!updated) {
    throw new AppError({
      message: "Linha não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  const cat = await postgres.query((db) =>
    db.query.chartOfAccount.findFirst({
      where: (c, ops) =>
        ops.and(
          ops.eq(c.id, updated.accountId),
          ops.or(ops.isNull(c.condominiumId), ops.eq(c.condominiumId, condominiumId)),
        ),
    })
  );
  const categoryName = cat?.name;

  return ctx.json({ data: formatBudgetLineForResponse(updated, { categoryName }) }, STATUS_CODE.OK);
};
