import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { formatUnitForResponse, UNIT_PROJECTION } from "$api/modules/admin/unit/_projection.ts";
import { unitNaturalOrder } from "$api/libs/postgres/order_by.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";

export const listUnits = async (ctx: Context, postgres: Postgres) => {
  const id = requireParam(ctx, "id");

  const result = await postgres.query((db) =>
    db.query.unit.findMany({
      where: (entity, ops) =>
        ops.and(
          ops.eq(entity.condominiumId, id),
          ops.isNull(entity.deletedAt),
        ),
      ...UNIT_PROJECTION,
      // Ordem natural: A, B, …, Z, AA, AB, … (length asc + alfabético).
      orderBy: unitNaturalOrder(schema.unit.designation),
    })
  );

  const data = result.map((e) => formatUnitForResponse(e));
  return ctx.json({ data });
};
