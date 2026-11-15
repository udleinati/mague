import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";

export const deleteCondominium = async (ctx: Context, postgres: Postgres) => {
  const id = requireParam(ctx, "id");

  const existing = await postgres.query((db) =>
    db.query.condominium.findFirst({
      where: (entity, ops) =>
        ops.and(
          ops.eq(entity.id, id),
          ops.isNull(entity.deletedAt),
        ),
    })
  );
  if (!existing) {
    throw new AppError({
      message: "Condomínio não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  // Soft-delete: marca deletedAt, não toca isActive.
  await postgres.query((db) =>
    db.update(schema.condominium)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.condominium.id, id), isNull(schema.condominium.deletedAt)))
      .returning()
  );

  return new Response(null, { status: STATUS_CODE.NoContent });
};
