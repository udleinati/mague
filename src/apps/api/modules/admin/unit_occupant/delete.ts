import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const deleteUnitOccupant = async (ctx: Context, postgres: Postgres) => {
  const actor = requireActor(ctx);
  const unitId = requireParam(ctx, "unitId");
  const unitOccupantId = requireParam(ctx, "unitOccupantId");

  const existing = await postgres.query((db) =>
    db.query.unitOccupant.findFirst({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, unitOccupantId),
          ops.eq(e.unitId, unitId),
          ops.isNull(e.deletedAt),
        ),
    })
  );
  findEntityOrFail(existing, "Ocupante da fração");

  await postgres.query((db) =>
    db.update(schema.unitOccupant)
      .set({ deletedAt: new Date(), deletedBy: actor })
      .where(and(
        eq(schema.unitOccupant.id, unitOccupantId),
        eq(schema.unitOccupant.unitId, unitId),
        isNull(schema.unitOccupant.deletedAt),
      ))
      .returning()
  );

  return new Response(null, { status: STATUS_CODE.NoContent });
};
