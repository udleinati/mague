import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { formatUserForResponse, USER_PROJECTION } from "./_projection.ts";
import { loadLastInvitedAt } from "../../auth/invite_history.ts";

export const listUsers = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const [result, managersResult, unitOccupantsResult, unitsResult] = await Promise.all([
    postgres.query((db) =>
      db.query.user.findMany({
        where: (e, ops) =>
          ops.and(
            ops.isNull(e.deletedAt),
            ops.eq(e.isActive, true),
          ),
        orderBy: (e, ops) => ops.asc(e.name),
        ...USER_PROJECTION,
      })
    ),
    postgres.query((db) =>
      db.query.manager.findMany({
        where: (e, ops) =>
          ops.and(
            ops.eq(e.condominiumId, condominiumId),
            ops.isNull(e.deletedAt),
          ),
      })
    ),
    postgres.query((db) =>
      db.query.unitOccupant.findMany({
        // TODOS os tipos de relação (owner/tenant/resident); filtrar por 'owner'
        // escondia residentes/inquilinos, desalinhado com `/occupants`.
        where: (e, ops) => ops.isNull(e.deletedAt),
      })
    ),
    postgres.query((db) =>
      db.query.unit.findMany({
        columns: { id: true, designation: true, identifier: true },
        where: (e, ops) =>
          ops.and(
            ops.eq(e.condominiumId, condominiumId),
            ops.isNull(e.deletedAt),
          ),
      })
    ),
  ]);

  const managerUserIds = new Set(managersResult.map((a) => a.userId));
  const unitIds = new Set(unitsResult.map((u) => u.id));
  // Lookup `unitId -> { designation, identifier }` para a lista de frações por user.
  const unitInfoById = new Map(
    unitsResult.map((
      u,
    ) => [u.id, { designation: u.designation, identifier: u.identifier ?? null }]),
  );
  const relatedOccupantIds = new Set(
    unitOccupantsResult
      .filter((uo) => unitIds.has(uo.unitId))
      .map((uo) => uo.occupantId),
  );

  const occupantUserIdsResult = relatedOccupantIds.size > 0
    ? await postgres.query((db) =>
      db.query.occupant.findMany({
        where: (e, ops) =>
          ops.and(
            ops.inArray(e.id, [...relatedOccupantIds]),
            ops.isNull(e.deletedAt),
          ),
      })
    )
    : [];

  const occupantUserIds = new Set(
    occupantUserIdsResult
      .filter((o) => o.userId !== null)
      .map((o) => o.userId),
  );

  // Map userId -> occupantId NESTE condo, para o "convidar"
  // (`/occupants/:occId/invite`). Múltiplos occupants (raro): fica o primeiro.
  const userIdToOccupantId = new Map<string, string>();
  for (const o of occupantUserIdsResult) {
    if (o.userId && !userIdToOccupantId.has(o.userId)) {
      userIdToOccupantId.set(o.userId, o.id);
    }
  }

  const allRelatedUserIds = new Set([...managerUserIds, ...occupantUserIds]);

  // Map `userId -> units[]` (frações deste user no condo) para a coluna "Fração".
  const occupantIdToUserId = new Map<string, string>();
  for (const o of occupantUserIdsResult) {
    if (o.userId) occupantIdToUserId.set(o.id, o.userId);
  }
  const userIdToUnits = new Map<
    string,
    Array<{
      unitId: string;
      designation: string;
      identifier: string | null;
      relationshipType: string;
    }>
  >();
  for (const uo of unitOccupantsResult) {
    if (!unitIds.has(uo.unitId)) continue;
    const userId = occupantIdToUserId.get(uo.occupantId);
    if (!userId) continue;
    const info = unitInfoById.get(uo.unitId);
    if (!info) continue;
    const arr = userIdToUnits.get(userId) ?? [];
    arr.push({
      unitId: uo.unitId,
      designation: info.designation,
      identifier: info.identifier,
      relationshipType: uo.relationshipType,
    });
    userIdToUnits.set(userId, arr);
  }

  // Último convite (`purpose='invite'`) por user, fonte única partilhada com o
  // guard de reenvio (`invite_history.ts`): display e enforcement coincidem. ADR 0032.
  const lastInvitedAtByUserId = await loadLastInvitedAt(postgres, [...allRelatedUserIds]);

  const data = result
    .filter((u) => allRelatedUserIds.has(u.id))
    .map((u) =>
      formatUserForResponse(
        u,
        managerUserIds.has(u.id),
        userIdToOccupantId.get(u.id) ?? null,
        lastInvitedAtByUserId.get(u.id) ?? null,
        userIdToUnits.get(u.id) ?? [],
      )
    );

  return ctx.json({ data });
};
