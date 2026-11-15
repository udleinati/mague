import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { formatUnitOccupantForResponse, UNIT_OCCUPANT_PROJECTION } from "./_projection.ts";

export const listUnitOccupants = async (ctx: Context, postgres: Postgres) => {
  const unitId = requireParam(ctx, "unitId");

  const result = await postgres.query((db) =>
    db.query.unitOccupant.findMany({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.unitId, unitId),
          ops.isNull(e.deletedAt),
        ),
      orderBy: (e, ops) => ops.asc(e.startDate),
      ...UNIT_OCCUPANT_PROJECTION,
    })
  );

  const data = result.map(formatUnitOccupantForResponse);
  return ctx.json({ data });
};
