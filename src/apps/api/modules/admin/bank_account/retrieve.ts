import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { BANK_ACCOUNT_PROJECTION, formatBankAccountForResponse } from "./_projection.ts";

export const getBankAccount = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const id = requireParam(ctx, "bankAccountId");

  const result = await postgres.query((db) =>
    db.query.bankAccount.findFirst({
      where: byIdInCondo(schema.bankAccount, id, condominiumId),
      ...BANK_ACCOUNT_PROJECTION,
    })
  );
  const bankAccount = findEntityOrFail(result, "Conta bancária");

  return ctx.json({ data: formatBankAccountForResponse(bankAccount) });
};
