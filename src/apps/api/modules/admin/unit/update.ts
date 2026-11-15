import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { unitUpdateDescriptionSchema } from "$api/libs/model/admin_unit.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatUnitForResponse } from "./_projection.ts";

export const updateMeUnit = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const unitId = requireParam(ctx, "unitId");

  const body = await dtoValidator(unitUpdateDescriptionSchema, await ctx.req.json());

  const existing = await postgres.query((db) =>
    db.query.unit.findFirst({
      where: byIdInCondo(schema.unit, unitId, condominiumId),
    })
  );
  const existingData = findEntityOrFail(existing, "Fração");

  // Designação mudou: checar duplicado para devolver 409 em vez de 500 (UNIQUE).
  if (
    body.designation !== undefined &&
    body.designation !== existingData.designation
  ) {
    const conflict = await postgres.query((db) =>
      db.query.unit.findFirst({
        columns: { id: true },
        where: (e, ops) =>
          ops.and(
            ops.eq(e.condominiumId, condominiumId),
            ops.eq(e.designation, body.designation!),
            ops.isNull(e.deletedAt),
          ),
      })
    );
    if (conflict && conflict.id !== unitId) {
      throw new AppError({
        message: `Já existe uma fração com a designação "${body.designation}" neste condomínio`,
        statusCode: STATUS_CODE.Conflict,
        code: "DUPLICATE_DESIGNATION",
      });
    }
  }

  // Limpa + dedup das keywords (trim, remove vazios). Mantém ordem original.
  const cleanedMatchKeywords = body.matchKeywords !== undefined
    ? [...new Set(body.matchKeywords.map((k) => k.trim()).filter((k) => k.length > 0))]
    : undefined;

  const update = await postgres.transaction((tx) =>
    tx.update(schema.unit)
      .set({
        description: body.description !== undefined ? body.description : existingData.description,
        designation: body.designation !== undefined ? body.designation : existingData.designation,
        floor: body.floor !== undefined ? body.floor : existingData.floor,
        door: body.door !== undefined ? body.door : existingData.door,
        block: body.block !== undefined ? body.block : existingData.block,
        matchKeywords: cleanedMatchKeywords !== undefined
          ? cleanedMatchKeywords
          : existingData.matchKeywords,
        updatedAt: new Date(),
        updatedBy: requireActor(ctx) ?? existingData.updatedBy,
      })
      .where(byIdInCondo(schema.unit, unitId, condominiumId))
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
