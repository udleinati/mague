import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { bankAccountUpdateSchema } from "$api/libs/model/bank_account.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatBankAccountForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const updateBankAccount = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const id = requireParam(ctx, "bankAccountId");

  const body = await dtoValidator(bankAccountUpdateSchema, await ctx.req.json());

  const existing = await postgres.query((db) =>
    db.query.bankAccount.findFirst({
      where: byIdInCondo(schema.bankAccount, id, condominiumId),
    })
  );
  const data = findEntityOrFail(existing, "Conta bancária");

  const update = await postgres.query((db) =>
    db.update(schema.bankAccount)
      .set({
        bankName: body.bankName ?? data.bankName,
        iban: body.iban !== undefined ? body.iban : data.iban,
        accountName: body.accountName !== undefined ? body.accountName : data.accountName,
        accountHolder: body.accountHolder !== undefined ? body.accountHolder : data.accountHolder,
        isQuotaPayment: body.isQuotaPayment !== undefined
          ? body.isQuotaPayment
          : data.isQuotaPayment,
        kind: body.kind !== undefined ? body.kind : data.kind,
        isActive: body.isActive !== undefined ? body.isActive : data.isActive,
        openingBalance: body.openingBalance !== undefined
          ? body.openingBalance
          : data.openingBalance,
        openingBalanceDate: body.openingBalanceDate !== undefined
          ? body.openingBalanceDate
          : data.openingBalanceDate,
        csvConfig: body.csvConfig !== undefined ? body.csvConfig : data.csvConfig,
        updatedBy: actor,
      })
      .where(byIdInCondo(schema.bankAccount, id, condominiumId))
      .returning()
  );

  const updated = update[0];
  if (!updated) {
    throw new AppError({
      message: "Conta bancária não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  return ctx.json({ data: formatBankAccountForResponse(updated) });
};
