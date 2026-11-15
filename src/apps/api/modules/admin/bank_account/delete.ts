import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const deleteBankAccount = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const id = requireParam(ctx, "bankAccountId");

  const existing = await postgres.query((db) =>
    db.query.bankAccount.findFirst({
      where: byIdInCondo(schema.bankAccount, id, condominiumId),
    })
  );
  findEntityOrFail(existing, "Conta bancária");

  await postgres.query((db) =>
    db.update(schema.bankAccount)
      .set({ deletedAt: new Date(), deletedBy: actor })
      .where(byIdInCondo(schema.bankAccount, id, condominiumId))
      .returning()
  );

  return new Response(null, { status: STATUS_CODE.NoContent });
};
