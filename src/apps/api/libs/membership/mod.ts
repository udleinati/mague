// I/O wrapper do membership: carrega rows e alimenta `computeUserMembership`
// (puro, em compute.ts). I/O thin, logic puro (ADR 0001); tests em compute_test.ts.

import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { computeUserMembership, type UserMembership } from "./compute.ts";

export type { CondoMembership, UserMembership } from "./compute.ts";
export { accountReachableOutside } from "./compute.ts";

// Carrega o snapshot de "vinculação" do user (managers incl. soft-deleted,
// occupants/unit_occupants ativos, map unit->cid). Null se user não existe ou
// soft-deleted. Até 3 fases sequenciais por causa das FK chains.
export async function loadUserMembership(
  postgres: Postgres,
  userId: string,
  opts: { includeInactive?: boolean } = {},
): Promise<UserMembership | null> {
  // Fase 1: user + managers + occupants em paralelo. managers SEM filtro
  // (precisamos da história); user filtra `is_active=true` por defeito (ADR
  // 0020), exceto com `includeInactive` (admin a listar/reactivar inativos).
  const [user, managers, activeOccupants] = await Promise.all([
    postgres.query((db) =>
      db.query.user.findFirst({
        where: (u, o) => {
          const baseConds = [o.eq(u.id, userId), o.isNull(u.deletedAt)];
          if (!opts.includeInactive) baseConds.push(o.eq(u.isActive, true));
          return o.and(...baseConds);
        },
      })
    ),
    postgres.query((db) =>
      db.query.manager.findMany({
        where: (m, o) => o.eq(m.userId, userId),
      })
    ),
    postgres.query((db) =>
      db.query.occupant.findMany({
        where: (o, ops) => ops.and(ops.eq(o.userId, userId), ops.isNull(o.deletedAt)),
      })
    ),
  ]);
  if (!user) return null;

  // Fase 2: unit_occupants para os occupants encontrados + condos apagados
  // entre os da vinculação (soft-delete do condo corta o acesso).
  const occupantIds = activeOccupants.map((o) => o.id);
  const condoIds = [
    ...new Set([...managers, ...activeOccupants].map((r) => r.condominiumId)),
  ];
  const [activeUnitOccupants, deletedCondos] = await Promise.all([
    occupantIds.length > 0
      ? postgres.query((db) =>
        db.query.unitOccupant.findMany({
          where: (uo, ops) =>
            ops.and(
              ops.inArray(uo.occupantId, occupantIds),
              ops.isNull(uo.deletedAt),
              ops.isNull(uo.endDate),
            ),
        })
      )
      : [],
    condoIds.length > 0
      ? postgres.query((db) =>
        db.query.condominium.findMany({
          columns: { id: true },
          where: (c, ops) => ops.and(ops.inArray(c.id, condoIds), ops.isNotNull(c.deletedAt)),
        })
      )
      : [],
  ]);

  // Fase 3: units das unit_occupants, para mapear unit->cid. Só ativas
  // (defesa multi-tenant: unit_occupant órfão a apontar para unit eliminada
  // não conta).
  const unitIds = activeUnitOccupants.map((uo) => uo.unitId);
  const units = unitIds.length > 0
    ? await postgres.query((db) =>
      db.query.unit.findMany({
        columns: { id: true, condominiumId: true },
        where: (u, ops) =>
          ops.and(
            ops.inArray(u.id, unitIds),
            ops.isNull(u.deletedAt),
          ),
      })
    )
    : [];

  const unitsByCondoId = new Map<string, Set<string>>();
  for (const u of units) {
    let s = unitsByCondoId.get(u.condominiumId);
    if (!s) {
      s = new Set<string>();
      unitsByCondoId.set(u.condominiumId, s);
    }
    s.add(u.id);
  }

  return computeUserMembership({
    user,
    managers,
    activeOccupants,
    activeUnitOccupants,
    unitsByCondoId,
    deletedCondoIds: new Set(deletedCondos.map((c) => c.id)),
    today: new Date().toISOString().slice(0, 10),
  });
}
