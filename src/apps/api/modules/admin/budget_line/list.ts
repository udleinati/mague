import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { BUDGET_LINE_PROJECTION, formatBudgetLineForResponse } from "./_projection.ts";

export const listBudgetLines = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const budgetId = ctx.req.param("budgetId");
  if (!budgetId) {
    return ctx.json({ data: [] });
  }

  const budget = await postgres.query((db) =>
    db.query.budget.findFirst({
      where: byIdInCondo(schema.budget, budgetId, condominiumId),
    })
  );

  if (!budget) {
    return ctx.json({ data: [] });
  }

  const lines = await postgres.query((db) =>
    db.query.budgetLine.findMany({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.budgetId, budgetId),
          ops.isNull(e.deletedAt),
        ),
      orderBy: (e, ops) => ops.asc(e.createdAt),
      ...BUDGET_LINE_PROJECTION,
    })
  );

  const linesWithCategories = await Promise.all(
    lines.map(async (line) => {
      const cat = await postgres.query((db) =>
        db.query.chartOfAccount.findFirst({
          where: (c, ops) =>
            ops.and(
              ops.eq(c.id, line.accountId),
              ops.or(ops.isNull(c.condominiumId), ops.eq(c.condominiumId, condominiumId)),
            ),
        })
      );
      const categoryName = cat?.name;
      return formatBudgetLineForResponse(line, { categoryName });
    }),
  );

  return ctx.json({ data: linesWithCategories });
};
