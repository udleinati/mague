import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

export const deleteUnit = async (ctx: Context, postgres: Postgres) => {
  const unitId = ctx.req.param("unitId");

  if (!unitId) {
    throw new AppError({
      message: "unitId é obrigatório",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const existing = await postgres.query((db) =>
    db.query.unit.findFirst({
      where: (e, ops) =>
        ops.and(
          ops.eq(e.id, unitId),
          ops.isNull(e.deletedAt),
        ),
    })
  );
  if (!existing) {
    throw new AppError({
      message: "Fração não encontrada",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  await postgres.query((db) =>
    db.update(schema.unit)
      .set({ deletedAt: new Date(), deletedBy: requireActor(ctx) })
      .where(and(
        eq(schema.unit.id, unitId),
        isNull(schema.unit.deletedAt),
      ))
      .returning()
  );

  return new Response(null, { status: STATUS_CODE.NoContent });
};
