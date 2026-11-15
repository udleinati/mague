import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { listWhere } from "$api/libs/shared/list_query.ts";
import { BANK_ACCOUNT_PROJECTION, formatBankAccountForResponse } from "./_projection.ts";

export const listBankAccounts = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const result = await postgres.query((db) =>
    db.query.bankAccount.findMany({
      where: listWhere(schema.bankAccount, condominiumId),
      orderBy: (e, ops) => ops.asc(e.bankName),
      ...BANK_ACCOUNT_PROJECTION,
    })
  );

  const data = result.map(formatBankAccountForResponse);
  return ctx.json({ data });
};
