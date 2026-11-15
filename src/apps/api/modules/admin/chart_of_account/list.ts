import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { CHART_OF_ACCOUNT_PROJECTION, formatChartOfAccountForResponse } from "./_projection.ts";

/**
 * Listagem de contas:
 *   - Globais (condominiumId IS NULL) - sempre incluídas
 *   - Customs do condomínio do path (ADR 0009)
 */
export const listChartOfAccounts = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const result = await postgres.query((db) =>
    db.query.chartOfAccount.findMany({
      where: (e, ops) =>
        ops.and(
          ops.or(ops.isNull(e.condominiumId), ops.eq(e.condominiumId, condominiumId)),
          ops.isNull(e.deletedAt),
        ),
      orderBy: (e, ops) => [ops.asc(e.code), ops.asc(e.name)],
      ...CHART_OF_ACCOUNT_PROJECTION,
    })
  );

  const data = result.map(formatChartOfAccountForResponse);
  return ctx.json({ data });
};
