import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { formatUnitOccupantForResponse, UNIT_OCCUPANT_PROJECTION } from "./_projection.ts";

export const getUnitOccupant = async (ctx: Context, postgres: Postgres) => {
  const unitId = requireParam(ctx, "unitId");
  const unitOccupantId = requireParam(ctx, "unitOccupantId");

  const result = await postgres.query((db) =>
    db.query.unitOccupant.findFirst({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, unitOccupantId),
          ops.eq(e.unitId, unitId),
          ops.isNull(e.deletedAt),
        ),
      ...UNIT_OCCUPANT_PROJECTION,
    })
  );
  const row = findEntityOrFail(result, "Ocupante da fração");
  return ctx.json({ data: formatUnitOccupantForResponse(row) });
};
