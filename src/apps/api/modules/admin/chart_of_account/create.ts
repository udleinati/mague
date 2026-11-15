import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { chartOfAccountCreateSchema } from "$api/libs/model/chart_of_account.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatChartOfAccountForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const createChartOfAccount = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);

  const body = await dtoValidator(chartOfAccountCreateSchema, await ctx.req.json());

  const insert = await postgres.query((db) =>
    db.insert(schema.chartOfAccount).values({
      condominiumId,
      code: body.code,
      name: body.name,
      type: body.type,
      parentCode: body.parentCode ?? null,
      description: body.description ?? null,
      createdBy: actor,
      updatedBy: actor,
    }).returning()
  );

  const created = insert[0];
  if (!created) {
    throw new AppError({
      message: "Erro ao criar conta",
      statusCode: STATUS_CODE.InternalServerError,
      code: "DB_ERROR",
    });
  }

  return ctx.json({ data: formatChartOfAccountForResponse(created) }, STATUS_CODE.Created);
};
