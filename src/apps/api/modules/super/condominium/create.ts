import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { condominiumCreateSchema } from "$api/libs/model/condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatCondominiumForResponse } from "$api/modules/admin/condominium/_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const createCondominium = async (ctx: Context, postgres: Postgres) => {
  const body = await dtoValidator(condominiumCreateSchema, await ctx.req.json());
  const actor = requireActor(ctx);

  const insert = await postgres.query((db) =>
    db.insert(schema.condominium).values({
      name: body.name,
      designationType: body.designationType ?? "condominium",
      fiscalNumber: body.fiscalNumber ?? null,
      email: body.email ?? null,
      address: body.address ?? null,
      city: body.city ?? null,
      postalCode: body.postalCode ?? null,
      quotaDayOfMonth: body.quotaDayOfMonth ?? 1,
      createdBy: actor,
      updatedBy: actor,
    }).returning()
  );

  const created = insert[0];
  if (!created) {
    throw new AppError({ message: "Erro ao criar condomínio", statusCode: 500, code: "DB_ERROR" });
  }

  return ctx.json({ data: formatCondominiumForResponse(created) }, STATUS_CODE.Created);
};
