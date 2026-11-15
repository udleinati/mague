import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { bankTransactionCreateSchema } from "$api/libs/model/bank_transaction.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatBankTransactionForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { assertBankAccountBelongs } from "$api/libs/shared/assert_ownership.ts";

export const createBankTransaction = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const body = await dtoValidator(bankTransactionCreateSchema, await ctx.req.json());

  // Ownership: senão um manager de A apontaria um movimento à bank_account de B.
  await assertBankAccountBelongs(postgres, body.bankAccountId, condominiumId);

  const insert = await postgres.query((db) =>
    db.insert(schema.bankTransaction).values({
      condominiumId,
      bankAccountId: body.bankAccountId,
      transactionDate: body.transactionDate,
      valueDate: body.valueDate ?? null,
      amount: body.amount,
      description: body.description ?? null,
      balanceAfter: body.balanceAfter ?? null,
      importHash: body.importHash ?? null,
      notes: body.notes ?? null,
      createdBy: requireActor(ctx),
      updatedBy: requireActor(ctx),
    }).returning()
  );

  const created = insert[0];
  if (!created) {
    throw new AppError({
      message: "Erro ao criar movimento bancário",
      statusCode: STATUS_CODE.InternalServerError,
      code: "DB_ERROR",
    });
  }

  return ctx.json({ data: formatBankTransactionForResponse(created) }, STATUS_CODE.Created);
};
