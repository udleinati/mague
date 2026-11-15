import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { chartOfAccountUpdateSchema } from "$api/libs/model/chart_of_account.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatChartOfAccountForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const updateChartOfAccount = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const accountId = requireParam(ctx, "accountId");

  const body = await dtoValidator(chartOfAccountUpdateSchema, await ctx.req.json());

  const existing = await postgres.query((db) =>
    db.query.chartOfAccount.findFirst({
      where: byIdInCondo(schema.chartOfAccount, accountId, condominiumId),
    })
  );
  const existingData = findEntityOrFail(existing, "Conta");

  const update = await postgres.query((db) =>
    db.update(schema.chartOfAccount)
      .set({
        code: body.code ?? existingData.code,
        name: body.name ?? existingData.name,
        type: body.type ?? existingData.type,
        parentCode: body.parentCode !== undefined ? body.parentCode : existingData.parentCode,
        isActive: body.isActive !== undefined ? body.isActive : existingData.isActive,
        description: body.description !== undefined ? body.description : existingData.description,
        updatedAt: new Date(),
        updatedBy: actor,
      })
      .where(byIdInCondo(schema.chartOfAccount, accountId, condominiumId))
      .returning()
  );

  const updated = update[0];
  if (!updated) {
    throw new AppError({
      message: "Conta não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  return ctx.json({ data: formatChartOfAccountForResponse(updated) }, STATUS_CODE.OK);
};
