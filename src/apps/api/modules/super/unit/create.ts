import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { unitCreateSchema } from "$api/libs/model/unit.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatUnitForResponse } from "$api/modules/admin/unit/_projection.ts";

export const createUnit = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireParam(ctx, "id");

  const body = await dtoValidator(unitCreateSchema, await ctx.req.json());

  const insert = await postgres.query((db) =>
    db.insert(schema.unit).values({
      condominiumId: condominiumId,
      designation: body.designation,
      unitType: body.unitType,
      permillage: String(body.permillage),
      floor: body.floor ?? null,
      door: body.door ?? null,
      block: body.block ?? null,
      description: body.description ?? null,
    }).returning()
  );

  const created = insert[0];
  if (!created) {
    throw new AppError({ message: "Erro ao criar fração", statusCode: 500, code: "DB_ERROR" });
  }

  return ctx.json({ data: formatUnitForResponse(created) }, STATUS_CODE.Created);
};
