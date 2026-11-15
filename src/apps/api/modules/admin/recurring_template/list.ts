import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { listWhere } from "$api/libs/shared/list_query.ts";
import {
  formatRecurringTemplateForResponse,
  RECURRING_TEMPLATE_PROJECTION,
} from "./_projection.ts";

export const listRecurringTemplates = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const result = await postgres.query((db) =>
    db.query.recurringTemplate.findMany({
      where: listWhere(schema.recurringTemplate, condominiumId),
      orderBy: (e, ops) => ops.asc(e.nextRunDate),
      ...RECURRING_TEMPLATE_PROJECTION,
    })
  );

  const data = result.map(formatRecurringTemplateForResponse);
  return ctx.json({ data });
};
