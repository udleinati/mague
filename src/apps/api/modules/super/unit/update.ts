import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { unitUpdateSchema } from "$api/libs/model/unit.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatUnitForResponse } from "$api/modules/admin/unit/_projection.ts";

export const updateUnit = async (ctx: Context, postgres: Postgres) => {
  const id = ctx.req.param("id");
  const unitId = ctx.req.param("unitId");
  if (!id || !unitId) {
    throw new AppError({
      message: "ID inválido",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const body = await dtoValidator(unitUpdateSchema, await ctx.req.json());

  const existingData = await postgres.query((db) =>
    db.query.unit.findFirst({
      where: (entity, ops) =>
        ops.and(
          ops.eq(entity.id, unitId),
          ops.eq(entity.condominiumId, id),
          ops.isNull(entity.deletedAt),
        ),
    })
  );
  if (!existingData) {
    throw new AppError({
      message: "Fração não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  const update = await postgres.transaction((tx) =>
    tx.update(schema.unit)
      .set({
        designation: body.designation ?? existingData.designation,
        unitType: body.unitType ?? existingData.unitType,
        permillage: body.permillage !== undefined
          ? String(body.permillage)
          : existingData.permillage,
        // Nullable: `!== undefined` permite enviar null para limpar o campo.
        floor: body.floor !== undefined ? body.floor : existingData.floor,
        door: body.door !== undefined ? body.door : existingData.door,
        block: body.block !== undefined ? body.block : existingData.block,
        description: body.description !== undefined ? body.description : existingData.description,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.unit.id, unitId),
          eq(schema.unit.condominiumId, id),
          isNull(schema.unit.deletedAt),
        ),
      )
      .returning()
  );

  const updated = update[0];
  if (!updated) {
    throw new AppError({
      message: "Fração não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  return ctx.json({ data: formatUnitForResponse(updated) }, STATUS_CODE.OK);
};
