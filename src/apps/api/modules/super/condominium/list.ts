import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import {
  CONDOMINIUM_PROJECTION,
  formatCondominiumForResponse,
} from "$api/modules/admin/condominium/_projection.ts";

export const listCondominiums = async (ctx: Context, postgres: Postgres) => {
  const result = await postgres.query((db) =>
    db.query.condominium.findMany({
      where: (entity, ops) => ops.isNull(entity.deletedAt),
      orderBy: (entity, ops) => ops.asc(entity.name),
      ...CONDOMINIUM_PROJECTION,
    })
  );

  const data = result.map((e) => formatCondominiumForResponse(e));
  return ctx.json({ data });
};
