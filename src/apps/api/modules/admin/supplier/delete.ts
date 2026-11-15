import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const deleteSupplier = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const supplierId = requireParam(ctx, "supplierId");

  const existing = await postgres.query((db) =>
    db.query.supplier.findFirst({
      where: byIdInCondo(schema.supplier, supplierId, condominiumId),
    })
  );
  findEntityOrFail(existing, "Fornecedor");

  await postgres.query((db) =>
    db.update(schema.supplier)
      .set({ deletedAt: new Date(), updatedAt: new Date(), deletedBy: requireActor(ctx) })
      .where(byIdInCondo(schema.supplier, supplierId, condominiumId))
      .returning()
  );

  return new Response(null, { status: STATUS_CODE.NoContent });
};
