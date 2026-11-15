import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { CHARGE_PROJECTION, formatChargeForResponse } from "./_projection.ts";

export const getCharge = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const chargeId = requireParam(ctx, "chargeId");

  const result = await postgres.query((db) =>
    db.query.charge.findFirst({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, chargeId),
          ops.eq(e.condominiumId, condominiumId),
        ),
      // Nested unit/supplier/account + whitelist top-level.
      ...CHARGE_PROJECTION,
    })
  );
  const charge = findEntityOrFail(result, "Cobrança");

  return ctx.json({ data: formatChargeForResponse(charge) });
};
