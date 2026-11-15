import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { occupantUpdateSchema } from "$api/libs/model/occupant.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatOccupantForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const updateOccupant = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const occupantId = requireParam(ctx, "occupantId");

  const body = await dtoValidator(occupantUpdateSchema, await ctx.req.json());

  const existing = await postgres.query((db) =>
    db.query.occupant.findFirst({
      where: byIdInCondo(schema.occupant, occupantId, condominiumId),
    })
  );
  const existingData = findEntityOrFail(existing, "Occupante");

  const update = await postgres.query((db) =>
    db.update(schema.occupant)
      .set({
        name: body.name ?? existingData.name,
        email: body.email !== undefined ? body.email : existingData.email,
        nif: body.nif !== undefined ? body.nif : existingData.nif,
        phone: body.phone !== undefined ? body.phone : existingData.phone,
        personType: body.personType ?? existingData.personType,
        receiveReceiptEmails: body.receiveReceiptEmails ?? existingData.receiveReceiptEmails,
        updatedAt: new Date(),
        updatedBy: requireActor(ctx) ?? existingData.updatedBy,
      })
      .where(byIdInCondo(schema.occupant, occupantId, condominiumId))
      .returning()
  );

  const updated = update[0];
  if (!updated) {
    throw new AppError({
      message: "Occupante não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  return ctx.json({ data: formatOccupantForResponse(updated) }, STATUS_CODE.OK);
};
