import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { CHART_OF_ACCOUNT_PROJECTION, formatChartOfAccountForResponse } from "./_projection.ts";

export const getChartOfAccount = async (ctx: Context, postgres: Postgres) => {
  const accountId = requireParam(ctx, "accountId");

  const condominiumId = requireCondominiumId(ctx);

  // retrieve aceita conta global (condominiumId IS NULL) OU custom do condomínio
  const result = await postgres.query((db) =>
    db.query.chartOfAccount.findFirst({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, accountId),
          ops.or(ops.isNull(e.condominiumId), ops.eq(e.condominiumId, condominiumId)),
          ops.isNull(e.deletedAt),
        ),
      ...CHART_OF_ACCOUNT_PROJECTION,
    })
  );

  const account = findEntityOrFail(result, "Conta");

  return ctx.json({ data: formatChartOfAccountForResponse(account) });
};
