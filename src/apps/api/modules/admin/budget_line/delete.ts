import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const deleteBudgetLine = async (ctx: Context, postgres: Postgres) => {
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
      message: "Não é possível eliminar linhas de um orçamento já aprovado",
      statusCode: STATUS_CODE.Conflict,
      code: "CONFLICT",
    });
  }

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
  findEntityOrFail(existingResult, "Linha");

  await postgres.query((db) =>
    db.update(schema.budgetLine)
      .set({ deletedAt: new Date(), deletedBy: actor })
      .where(and(
        eq(schema.budgetLine.id, lineId),
        eq(schema.budgetLine.budgetId, budgetId),
        isNull(schema.budgetLine.deletedAt),
      ))
      .returning()
  );

  return new Response(null, { status: STATUS_CODE.NoContent });
};
