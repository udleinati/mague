import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const deleteBudget = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const budgetId = requireParam(ctx, "budgetId");

  const existing = await postgres.query((db) =>
    db.query.budget.findFirst({
      where: byIdInCondo(schema.budget, budgetId, condominiumId),
    })
  );
  const budget = findEntityOrFail(existing, "Orçamento");

  if (budget.status === "approved") {
    throw new AppError({
      message: "Não é possível eliminar um orçamento aprovado",
      statusCode: STATUS_CODE.Conflict,
      code: "CONFLICT",
    });
  }

  // Principal só pode ser eliminado se não tiver suplementares ativos
  if (budget.type === "principal") {
    const child = await postgres.query((db) =>
      db.query.budget.findFirst({
        where: (e, ops) =>
          ops.and(
            ops.eq(e.parentBudgetId, budgetId),
            ops.eq(e.condominiumId, condominiumId),
            ops.isNull(e.deletedAt),
          ),
      })
    );
    if (child) {
      throw new AppError({
        message: "Elimine primeiro os orçamentos suplementares associados",
        statusCode: STATUS_CODE.Conflict,
        code: "CONFLICT",
      });
    }
  }

  await postgres.query((db) =>
    db.update(schema.budget)
      .set({ deletedAt: new Date(), updatedAt: new Date(), deletedBy: requireActor(ctx) })
      .where(byIdInCondo(schema.budget, budgetId, condominiumId))
      .returning()
  );

  return new Response(null, { status: STATUS_CODE.NoContent });
};
