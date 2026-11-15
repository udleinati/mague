import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { assertOwnership } from "$api/libs/shared/assert_ownership.ts";
import { budgetLineCreateSchema } from "$api/libs/model/budget_line.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatBudgetLineForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const createBudgetLine = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const budgetId = ctx.req.param("budgetId");

  if (!budgetId) {
    throw new AppError({
      message: "budgetId é obrigatório",
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
      message: "Não é possível adicionar linhas a um orçamento já aprovado",
      statusCode: STATUS_CODE.Conflict,
      code: "CONFLICT",
    });
  }

  const body = await dtoValidator(budgetLineCreateSchema, await ctx.req.json());
  await assertOwnership(postgres, body, condominiumId, { account: "accountId" });

  const insertRows = await postgres.query((db) =>
    db.insert(schema.budgetLine).values({
      budgetId,
      accountId: body.accountId,
      annualAmount: body.annualAmount,
      notes: body.notes ?? null,
      createdBy: actor,
      updatedBy: actor,
    }).returning()
  );

  const created = insertRows[0];
  if (!created) {
    throw new AppError({
      message: "Erro ao criar linha de orçamento",
      statusCode: STATUS_CODE.InternalServerError,
      code: "DB_ERROR",
    });
  }

  const cat = await postgres.query((db) =>
    db.query.chartOfAccount.findFirst({
      where: (c, ops) => ops.eq(c.id, created.accountId),
    })
  );
  const categoryName = cat?.name;

  return ctx.json(
    { data: formatBudgetLineForResponse(created, { categoryName }) },
    STATUS_CODE.Created,
  );
};
