import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { dtoValidator } from "$api/libs/shared/dto_validator.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { assertOwnership } from "$api/libs/shared/assert_ownership.ts";
import { unitOccupantCreateSchema } from "$api/libs/model/unit_occupant.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatUnitOccupantForResponse } from "./_projection.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const createUnitOccupant = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);
  const unitId = requireParam(ctx, "unitId");

  const body = await dtoValidator(unitOccupantCreateSchema, await ctx.req.json());

  // Anti-IDOR: `:unitId` do path tem que bater com `body.unitId`, senão um
  // caller criaria link numa fração diferente da do path.
  if (body.unitId !== unitId) {
    throw new AppError({
      message: "unitId do body tem que ser igual ao do path",
      statusCode: STATUS_CODE.BadRequest,
      code: "UNIT_ID_MISMATCH",
    });
  }
  // A fração já vem validada pelo `requireUnitInCondo`; o ocupante do body não.
  await assertOwnership(postgres, body, condominiumId, { occupant: "occupantId" });

  const existing = await postgres.query((db) =>
    db.query.unitOccupant.findFirst({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.unitId, body.unitId),
          ops.eq(e.occupantId, body.occupantId),
          ops.eq(e.relationshipType, body.relationshipType),
          ops.isNull(e.deletedAt),
          ops.isNull(e.endDate),
        ),
    })
  );
  if (existing) {
    throw new AppError({
      message: "Já existe uma relação ativa para este ocupante nesta fração",
      statusCode: STATUS_CODE.Conflict,
      code: "CONFLICT",
    });
  }

  const insert = await postgres.query((db) =>
    db.insert(schema.unitOccupant).values({
      unitId: body.unitId,
      occupantId: body.occupantId,
      relationshipType: body.relationshipType,
      startDate: body.startDate ?? new Date().toISOString().slice(0, 10),
      createdBy: actor,
      updatedBy: actor,
    }).returning()
  );

  const created = insert[0];
  if (!created) {
    throw new AppError({
      message: "Erro ao criar relação",
      statusCode: STATUS_CODE.InternalServerError,
      code: "DB_ERROR",
    });
  }

  return ctx.json({ data: formatUnitOccupantForResponse(created) }, STATUS_CODE.Created);
};
