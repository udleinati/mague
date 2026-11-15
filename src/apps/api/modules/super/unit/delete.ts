import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { AppError } from "$api/libs/error/app_error.ts";

export const deleteUnit = async (ctx: Context, postgres: Postgres) => {
  const id = ctx.req.param("id");
  const unitId = ctx.req.param("unitId");
  if (!id || !unitId) {
    throw new AppError({
      message: "ID inválido",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const existing = await postgres.query((db) =>
    db.query.unit.findFirst({
      where: (entity, ops) =>
        ops.and(
          ops.eq(entity.id, unitId),
          ops.eq(entity.condominiumId, id),
          ops.isNull(entity.deletedAt),
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

  // Soft-delete: marca deletedAt, não toca isActive.
  await postgres.query((db) =>
    db.update(schema.unit)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.unit.id, unitId),
          eq(schema.unit.condominiumId, id),
          isNull(schema.unit.deletedAt),
        ),
      )
      .returning()
  );

  return new Response(null, { status: STATUS_CODE.NoContent });
};
