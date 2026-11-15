import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";

export const deleteUnitOccupantByOccupant = async (ctx: Context, postgres: Postgres) => {
  const unitId = requireParam(ctx, "unitId");
  const occupantId = requireParam(ctx, "occupantId");

  const found = await postgres.query((db) =>
    db.query.unitOccupant.findFirst({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.occupantId, occupantId),
          ops.eq(e.unitId, unitId),
          ops.isNull(e.deletedAt),
        ),
    })
  );
  const existing = findEntityOrFail(found, "Ocupante da fração");

  await postgres.query((db) =>
    db.update(schema.unitOccupant)
      .set({ deletedAt: new Date() })
      .where(and(
        eq(schema.unitOccupant.id, existing.id),
        isNull(schema.unitOccupant.deletedAt),
      ))
      .returning()
  );

  return new Response(null, { status: STATUS_CODE.NoContent });
};
