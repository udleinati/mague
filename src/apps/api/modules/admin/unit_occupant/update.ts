import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { unitOccupantUpdateSchema } from "$api/libs/model/unit_occupant.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatUnitOccupantForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const updateUnitOccupant = async (ctx: Context, postgres: Postgres) => {
  const actor = requireActor(ctx);
  const unitId = requireParam(ctx, "unitId");
  const unitOccupantId = requireParam(ctx, "unitOccupantId");

  const body = await dtoValidator(unitOccupantUpdateSchema, await ctx.req.json());

  const existing = await postgres.query((db) =>
    db.query.unitOccupant.findFirst({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, unitOccupantId),
          ops.eq(e.unitId, unitId),
          ops.isNull(e.deletedAt),
        ),
    })
  );
  const existingData = findEntityOrFail(existing, "Ocupante da fração");

  const update = await postgres.query((db) =>
    db.update(schema.unitOccupant)
      .set({
        relationshipType: body.relationshipType ?? existingData.relationshipType,
        // Coluna `date` aceita string (YYYY-MM-DD, já validada por Zod); NÃO
        // `new Date(...)`, que o PgUpdateSetSource rejeita para colunas `date`.
        startDate: body.startDate ?? existingData.startDate,
        endDate: body.endDate !== undefined ? (body.endDate ?? null) : existingData.endDate,
        updatedBy: actor,
      })
      .where(and(
        eq(schema.unitOccupant.id, unitOccupantId),
        eq(schema.unitOccupant.unitId, unitId),
        isNull(schema.unitOccupant.deletedAt),
      ))
      .returning()
  );

  const updated = update[0];
  if (!updated) {
    throw new AppError({
      message: "Ocupante da fração não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  return ctx.json({ data: formatUnitOccupantForResponse(updated) }, STATUS_CODE.OK);
};
