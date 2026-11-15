import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const deleteChartOfAccount = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const accountId = requireParam(ctx, "accountId");

  // Apenas contas CUSTOM do condomínio podem ser apagadas (nunca globais)
  const existing = await postgres.query((db) =>
    db.query.chartOfAccount.findFirst({
      where: byIdInCondo(schema.chartOfAccount, accountId, condominiumId),
    })
  );
  findEntityOrFail(existing, "Conta");

  await postgres.query((db) =>
    db.update(schema.chartOfAccount)
      .set({ deletedAt: new Date(), deletedBy: actor, updatedAt: new Date(), updatedBy: actor })
      .where(byIdInCondo(schema.chartOfAccount, accountId, condominiumId))
      .returning()
  );

  return new Response(null, { status: STATUS_CODE.NoContent });
};
