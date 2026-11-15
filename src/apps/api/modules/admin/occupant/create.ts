import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { occupantCreateSchema } from "$api/libs/model/occupant.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatOccupantForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const createOccupant = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const body = await dtoValidator(occupantCreateSchema, await ctx.req.json());

  const insert = await postgres.query((db) =>
    db.insert(schema.occupant).values({
      condominiumId,
      name: body.name,
      email: body.email ?? null,
      nif: body.nif ?? null,
      phone: body.phone ?? null,
      personType: body.personType ?? "singular",
      createdBy: requireActor(ctx),
      updatedBy: requireActor(ctx),
    }).returning()
  );

  const created = insert[0];
  if (!created) {
    throw new AppError({
      message: "Erro ao criar ocupante",
      statusCode: STATUS_CODE.InternalServerError,
      code: "DB_ERROR",
    });
  }

  return ctx.json({ data: formatOccupantForResponse(created) }, STATUS_CODE.Created);
};
