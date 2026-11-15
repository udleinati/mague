import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { accountReachableOutside, loadUserMembership } from "$api/libs/membership/mod.ts";
import { formatUserForResponse, type UserUnitSummary } from "./_projection.ts";
import { loadLastInvitedAt } from "../../auth/invite_history.ts";

export const getUser = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const userId = ctx.req.param("userId");
  if (!userId) {
    throw new AppError({
      message: "userId é obrigatório",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  // Vinculação do user a este condo, incl. relação histórica (manager
  // soft-deleted) e users inativos, para audit/restore. Ver ADR 0002 e 0020.
  const membership = await loadUserMembership(postgres, userId, { includeInactive: true });
  if (!membership) {
    throw new AppError({
      message: "Utilizador não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  const condoMembership = membership.inCondo(condominiumId);
  // `isRelated` cobre manager + owner; `isOccupantOfCondo` adiciona
  // tenant/resident. Paridade com `list.ts` (senão 404 ao editar residente).
  if (!condoMembership.isRelated && !condoMembership.isOccupantOfCondo) {
    throw new AppError({
      message: "Utilizador não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  // Frações deste user NESTE condo (qualquer relationship_type), via query
  // dedicada em vez de expor `activeUnitOccupants` no `UserMembership`.
  const occupantIds = condoMembership.activeOccupants.map((o) => o.id);
  const units: UserUnitSummary[] = occupantIds.length === 0
    ? []
    : await postgres.query((db) =>
      db.query.unitOccupant.findMany({
        where: (e, ops) =>
          ops.and(
            ops.inArray(e.occupantId, occupantIds),
            ops.isNull(e.deletedAt),
            ops.isNull(e.endDate),
          ),
        with: {
          unit: { columns: { id: true, designation: true, identifier: true, condominiumId: true } },
        },
      })
    ).then((rows) =>
      rows
        .filter((uo) => uo.unit && uo.unit.condominiumId === condominiumId)
        .map((uo) => ({
          unitId: uo.unit!.id,
          designation: uo.unit!.designation,
          identifier: uo.unit!.identifier ?? null,
          relationshipType: uo.relationshipType,
        }))
    );

  // occupantId (botão de convite) + último convite (fonte única, ADR 0032).
  // Mesmos campos que `list.ts` para o swap OOB pós-convite ficar correcto.
  const occupantId = occupantIds[0] ?? null;
  const lastInvitedAt = (await loadLastInvitedAt(postgres, [userId])).get(userId) ?? null;

  // Mesma regra do reset_password: o painel esconde o botão em vez de o deixar dar 403.
  const managed: string[] = ctx.get("managedCondominiumIds") ?? [];
  const passwordResetRequiresSuper = ctx.get("role") !== "super" &&
    (membership.isSuper || accountReachableOutside(membership, managed));

  return ctx.json({
    data: {
      ...formatUserForResponse(
        membership.user,
        condoMembership.isManager,
        occupantId,
        lastInvitedAt,
        units,
      ),
      passwordResetRequiresSuper,
    },
  });
};
