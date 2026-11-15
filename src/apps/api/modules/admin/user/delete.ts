import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { loadUserMembership } from "$api/libs/membership/mod.ts";
import { requireActor } from "$api/middleware/api_auth.ts";

// Soft-delete "remover user deste condomínio": manager + occupants +
// unit_occupants associados ficam com `deletedAt`. NÃO mexe em `core.user`
// (o utilizador continua global, com relações noutros condomínios).
export const deleteUser = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const actor = requireActor(ctx);
  const userId = requireParam(ctx, "userId");

  // `includeInactive`: admin pode remover relações per-condo de users inactivos (ADR 0020).
  const membership = await loadUserMembership(postgres, userId, { includeInactive: true });
  if (!membership) {
    throw new AppError({
      message: "Utilizador não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  const condoMembership = membership.inCondo(condominiumId);
  // Delete exige relação ACTIVA (manager ou occupant); retrieve/update aceitam
  // relação histórica para audit/restore.
  const hasActiveOccupants = condoMembership.activeOccupants.length > 0;
  if (!condoMembership.isManager && !hasActiveOccupants) {
    throw new AppError({
      message: "Utilizador não encontrado neste condomínio",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  const occupantIds = condoMembership.activeOccupants.map((o) => o.id);

  await postgres.transaction(async (tx) => {
    const now = new Date();
    if (condoMembership.isManager) {
      await tx.update(schema.manager)
        .set({ deletedAt: now, deletedBy: actor, updatedAt: now, updatedBy: actor })
        .where(and(
          eq(schema.manager.userId, userId),
          eq(schema.manager.condominiumId, condominiumId),
          isNull(schema.manager.deletedAt),
        ));
    }
    if (occupantIds.length > 0) {
      await tx.update(schema.unitOccupant)
        .set({ deletedAt: now, deletedBy: actor })
        .where(and(
          inArray(schema.unitOccupant.occupantId, occupantIds),
          isNull(schema.unitOccupant.deletedAt),
        ));
      await tx.update(schema.occupant)
        .set({ deletedAt: now, deletedBy: actor, updatedAt: now, updatedBy: actor })
        .where(and(
          inArray(schema.occupant.id, occupantIds),
          isNull(schema.occupant.deletedAt),
        ));
    }
  });

  return new Response(null, { status: STATUS_CODE.NoContent });
};
