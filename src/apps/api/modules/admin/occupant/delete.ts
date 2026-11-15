import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

// DELETE /v1/admin/c/:cid/occupants/:occupantId
//
// Cascade atómica numa transação: soft-deleta o ocupante E as suas ligações
// ativas (`core.unit_occupant`); ligações já soft-deleted ficam intactas.
// Vive aqui (não no caller) para garantir atomicidade sem orquestração N+1.
export const deleteOccupant = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const occupantId = requireParam(ctx, "occupantId");
  const actor = requireActor(ctx);

  const existing = await postgres.query((db) =>
    db.query.occupant.findFirst({
      where: byIdInCondo(schema.occupant, occupantId, condominiumId),
    })
  );
  findEntityOrFail(existing, "Occupante");

  const now = new Date();
  await postgres.query((db) =>
    db.transaction(async (tx) => {
      // 1. Cascade nas ligações ativas. Filtro só por `occupant_id`: o findFirst
      //    acima já validou que o ocupante pertence ao condo.
      await tx.update(schema.unitOccupant)
        .set({ deletedAt: now, deletedBy: actor })
        .where(and(
          eq(schema.unitOccupant.occupantId, occupantId),
          isNull(schema.unitOccupant.deletedAt),
        ));

      // 2. Soft-delete do próprio ocupante.
      await tx.update(schema.occupant)
        .set({ deletedAt: now, updatedAt: now, deletedBy: actor })
        .where(byIdInCondo(schema.occupant, occupantId, condominiumId));
    })
  );

  return new Response(null, { status: STATUS_CODE.NoContent });
};
