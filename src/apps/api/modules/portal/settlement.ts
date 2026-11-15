// /v1/portal/condominiums/:cid/units/:unitId/settlements - conciliações que tocam
// a fração. Filtro inclusivo (settlement.unit_id OU charge.unit_id); `:unitId` do
// path (query `?unitId=` ignorada).

import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { portalScope } from "$api/libs/portal/scope.ts";
import { parseLimit } from "$api/libs/shared/pagination.ts";
import {
  formatSettlementForResponse,
  SETTLEMENT_PROJECTION,
} from "$api/modules/admin/settlement/_projection.ts";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

export const portalListSettlements = async (ctx: Context, postgres: Postgres) => {
  const { cid: condominiumId, unitId } = portalScope(ctx);

  const dateFrom = ctx.req.query("dateFrom") ?? null;
  const dateTo = ctx.req.query("dateTo") ?? null;
  const limit = parseLimit(ctx.req.query("limit"), { default: DEFAULT_LIMIT, max: MAX_LIMIT });

  const result = await postgres.query((db) =>
    db.query.settlement.findMany({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.condominiumId, condominiumId),
          // Filtro inclusivo de unidade: settlement.unit_id = :unitId OU
          // ligado a charge cuja unit_id = :unitId.
          ops.or(
            ops.eq(e.unitId, unitId),
            sql`EXISTS (
            SELECT 1 FROM finance.charge c
             WHERE c.id IN (${e.debitChargeId}, ${e.creditChargeId})
               AND c.unit_id = ${unitId}
          )`,
          ),
          dateFrom ? ops.gte(e.settlementDate, dateFrom) : undefined,
          dateTo ? ops.lte(e.settlementDate, dateTo) : undefined,
        ),
      orderBy: (e, ops) => [ops.desc(e.settlementDate), ops.desc(e.createdAt)],
      ...SETTLEMENT_PROJECTION,
      limit,
    })
  );

  const data = result.map(formatSettlementForResponse);
  return ctx.json({ data });
};
