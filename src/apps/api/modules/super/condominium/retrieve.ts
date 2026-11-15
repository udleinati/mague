import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import {
  CONDOMINIUM_PROJECTION,
  formatCondominiumForResponse,
} from "$api/modules/admin/condominium/_projection.ts";

export const getCondominium = async (ctx: Context, postgres: Postgres) => {
  const id = requireParam(ctx, "id");

  const result = await postgres.query((db) =>
    db.query.condominium.findFirst({
      where: (entity, ops) =>
        ops.and(
          ops.eq(entity.id, id),
          ops.isNull(entity.deletedAt),
        ),
      ...CONDOMINIUM_PROJECTION,
    })
  );

  if (!result) {
    throw new AppError({
      message: "Condomínio não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  return ctx.json({ data: formatCondominiumForResponse(result) });
};
