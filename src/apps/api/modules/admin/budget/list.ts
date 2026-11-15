import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { listWhere } from "$api/libs/shared/list_query.ts";
import { BUDGET_PROJECTION, formatBudgetForResponse } from "./_projection.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { desc } from "drizzle-orm";

export const listBudgets = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const rows = await postgres.query((db) =>
    db.query.budget.findMany({
      where: listWhere(schema.budget, condominiumId),
      ...BUDGET_PROJECTION,
      orderBy: [desc(schema.budget.year)],
    })
  );

  const data = rows.map(formatBudgetForResponse);

  return ctx.json({ data });
};
