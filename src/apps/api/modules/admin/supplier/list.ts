import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { listWhere } from "$api/libs/shared/list_query.ts";
import { formatSupplierForResponse, SUPPLIER_PROJECTION } from "./_projection.ts";

export const listSuppliers = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const result = await postgres.query((db) =>
    db.query.supplier.findMany({
      where: listWhere(schema.supplier, condominiumId),
      orderBy: (e, ops) => ops.asc(e.name),
      ...SUPPLIER_PROJECTION,
    })
  );

  const data = result.map(formatSupplierForResponse);
  return ctx.json({ data });
};
