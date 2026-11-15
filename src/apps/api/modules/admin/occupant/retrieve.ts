import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { formatOccupantForResponse, OCCUPANT_PROJECTION } from "./_projection.ts";

export const getOccupant = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const occupantId = requireParam(ctx, "occupantId");

  const result = await postgres.query((db) =>
    db.query.occupant.findFirst({
      where: byIdInCondo(schema.occupant, occupantId, condominiumId),
      ...OCCUPANT_PROJECTION,
    })
  );

  const occupant = findEntityOrFail(result, "Occupante");

  return ctx.json({ data: formatOccupantForResponse(occupant) });
};
