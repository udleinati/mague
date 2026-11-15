// GET /v1/admin/condominiums/:cid/fcr-transfers
// Histórico de transferências entre bolsas, mais recente primeiro.

import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { formatFcrTransferForResponse } from "./_projection.ts";

export const listFcrTransfers = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const rows = await postgres.query((db) =>
    db.query.fcrTransfer.findMany({
      where: (t, ops) => ops.eq(t.condominiumId, condominiumId),
      orderBy: (t, ops) => [ops.desc(t.transferDate), ops.desc(t.createdAt)],
    })
  );

  return ctx.json({ data: rows.map(formatFcrTransferForResponse) });
};
