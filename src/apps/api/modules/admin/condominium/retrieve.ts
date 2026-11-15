import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { CONDOMINIUM_PROJECTION, formatCondominiumForResponse } from "./_projection.ts";

export const getMe = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  // Em paralelo: condomínio e saldo bancário (view v_bank_balance), poupando
  // o roundtrip a `/bank-accounts/balances` (dashboard, layout).
  const [condoResult, balanceResult] = await Promise.all([
    postgres.query((db) =>
      db.query.condominium.findFirst({
        where: (entity, ops) =>
          ops.and(
            ops.eq(entity.id, condominiumId),
            ops.isNull(entity.deletedAt),
          ),
        ...CONDOMINIUM_PROJECTION,
      })
    ),
    postgres.query((db) =>
      db.select().from(schema.bankBalance).where(
        eq(schema.bankBalance.condominiumId, condominiumId),
      )
    ),
  ]);

  const condo = findEntityOrFail(condoResult, "Condomínio");

  const balance = balanceResult[0];
  const bankBalance = balance
    ? {
      ordinaryCents: balance.ordinaryCents,
      fcrCents: balance.fcrCents,
      totalCents: balance.totalCents,
    }
    : undefined;

  return ctx.json({ data: formatCondominiumForResponse(condo, { bankBalance }) });
};
