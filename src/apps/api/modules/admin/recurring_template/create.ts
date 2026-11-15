import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { recurringTemplateCreateSchema } from "$api/libs/model/recurring_template.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatRecurringTemplateForResponse } from "./_projection.ts";
import { assertOwnership } from "$api/libs/shared/assert_ownership.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const createRecurringTemplate = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const body = await dtoValidator(recurringTemplateCreateSchema, await ctx.req.json());

  // Ownership das FK ids: senão um manager de A referenciaria unit/supplier/account de B.
  // NOTA: contractId sem schema próprio ainda; adicionar check quando o módulo contract existir.
  await assertOwnership(postgres, body, condominiumId, {
    unit: "unitId",
    supplier: "supplierId",
    account: "accountId",
  });

  const insert = await postgres.query((db) =>
    db.insert(schema.recurringTemplate).values({
      condominiumId,
      kind: body.kind,
      description: body.description,
      amount: body.amount,
      accountId: body.accountId ?? null,
      supplierId: body.supplierId ?? null,
      contractId: body.contractId ?? null,
      unitId: body.unitId ?? null,
      intervalType: body.intervalType,
      paymentMethod: body.paymentMethod ?? "manual",
      dayOfMonth: body.dayOfMonth ?? null,
      startDate: body.startDate,
      endDate: body.endDate ?? null,
      nextRunDate: body.nextRunDate,
      notes: body.notes ?? null,
      createdBy: actor,
      updatedBy: actor,
    }).returning()
  );

  const created = insert[0];
  if (!created) {
    throw new AppError({
      message: "Erro ao criar template recorrente",
      statusCode: STATUS_CODE.InternalServerError,
      code: "DB_ERROR",
    });
  }

  return ctx.json(
    { data: formatRecurringTemplateForResponse(created) },
    STATUS_CODE.Created,
  );
};
