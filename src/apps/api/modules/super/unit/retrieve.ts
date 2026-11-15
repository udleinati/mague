import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { formatUnitForResponse, UNIT_PROJECTION } from "$api/modules/admin/unit/_projection.ts";

export const getUnit = async (ctx: Context, postgres: Postgres) => {
  const id = ctx.req.param("id");
  const unitId = ctx.req.param("unitId");
  if (!id || !unitId) {
    throw new AppError({
      message: "ID inválido",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const result = await postgres.query((db) =>
    db.query.unit.findFirst({
      where: (entity, ops) =>
        ops.and(
          ops.eq(entity.id, unitId),
          ops.eq(entity.condominiumId, id),
          ops.isNull(entity.deletedAt),
        ),
      ...UNIT_PROJECTION,
    })
  );

  if (!result) {
    throw new AppError({
      message: "Fração não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  return ctx.json({ data: formatUnitForResponse(result) });
};
