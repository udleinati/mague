import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { bankAccountCreateSchema } from "$api/libs/model/bank_account.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatBankAccountForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const createBankAccount = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const body = await dtoValidator(bankAccountCreateSchema, await ctx.req.json());

  // Sem split, tudo ordinário (constraint bank_account_opening_split_matches exige total = ord+fcr).
  const openingTotal = body.openingBalance ?? 0;
  const insert = await postgres.query((db) =>
    db.insert(schema.bankAccount).values({
      condominiumId,
      bankName: body.bankName,
      iban: body.iban ?? null,
      accountName: body.accountName ?? null,
      accountHolder: body.accountHolder ?? null,
      isQuotaPayment: body.isQuotaPayment ?? false,
      kind: body.kind ?? "bank",
      openingBalance: openingTotal,
      openingBalanceOrdinaryCents: openingTotal,
      openingBalanceFcrCents: 0,
      openingBalanceDate: body.openingBalanceDate ?? null,
      csvConfig: body.csvConfig ?? null,
      createdBy: actor,
      updatedBy: actor,
    }).returning()
  );

  const created = insert[0];
  if (!created) {
    throw new AppError({
      message: "Erro ao criar conta bancária",
      statusCode: STATUS_CODE.InternalServerError,
      code: "DB_ERROR",
    });
  }

  return ctx.json({ data: formatBankAccountForResponse(created) }, STATUS_CODE.Created);
};
