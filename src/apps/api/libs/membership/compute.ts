// Pure functions for computing user->condo "vinculação" facts (ver ADR 0001 +
// CONTEXT.md). I/O wrapper em `mod.ts`; tests em `compute_test.ts` (sem DB).

import type { ManagerSelect } from "$api/libs/postgres/schemas/manager.ts";
import type { OccupantSelect } from "$api/libs/postgres/schemas/occupant.ts";
import type { UnitOccupantSelect } from "$api/libs/postgres/schemas/unit_occupant.ts";
import type { UserSelect } from "$api/libs/postgres/schemas/user.ts";

// Raw rows que alimentam `computeUserMembership`. Filtros que o I/O TEM de
// aplicar: user/occupants/units `deletedAt IS NULL`, unitOccupants ainda
// `endDate IS NULL`; managers SEM filtro (precisamos da história soft-deleted).
export interface MembershipRows {
  user: UserSelect;
  managers: ManagerSelect[];
  activeOccupants: OccupantSelect[];
  activeUnitOccupants: UnitOccupantSelect[];
  /** Map condominiumId → Set<unitId>. Built from units fetched at I/O time. */
  unitsByCondoId: Map<string, Set<string>>;
}

export interface UserMembership {
  userId: string;
  user: UserSelect;
  isSuper: boolean;
  /** Condos with active core.manager (deletedAt IS NULL AND isActive=true). */
  activeManagerCondoIds: string[];
  /** Condos with any core.manager (incl. soft-deleted). For audit. */
  historicManagerCondoIds: string[];
  /** Condos where user has active core.occupant. */
  occupantCondoIds: string[];
  /** Slice the membership for a specific condominium. */
  inCondo(cid: string): CondoMembership;
}

export interface CondoMembership {
  userId: string;
  condominiumId: string;
  isSuper: boolean;
  /** Active core.manager record exists for (userId, cid). */
  isManager: boolean;
  /** Any core.manager record (incl. soft-deleted) for (userId, cid). */
  hasManagerHistory: boolean;
  /** Raw record (active OR soft-deleted, whatever exists). Used by toggle
   *  for restore logic. Null if no record at all. */
  managerRecord: ManagerSelect | null;
  /** Active core.occupant records for this user in this cid. */
  activeOccupants: OccupantSelect[];
  /** activeOccupants.length > 0. */
  isOccupantOfCondo: boolean;
  /** Unit IDs in this cid where user has active 'owner' unit_occupant. */
  ownedUnitIds: string[];
  /** Unit IDs in this cid where user has ANY active unit_occupant (owner OR
   *  tenant). Usado por checks de acesso ao portal - onde inquilinos têm
   *  acesso à sua fração tal como proprietários. */
  linkedUnitIds: string[];
  /** isManager OR ownedUnitIds.length > 0. The default "currently in" check. */
  isCurrentlyRelated: boolean;
  /** hasManagerHistory OR isCurrentlyRelated. Used by retrieve/update for
   *  audit visibility - once admin, sempre visível mesmo após self-removal. */
  isRelated: boolean;
}

const isManagerActive = (m: ManagerSelect): boolean => m.deletedAt === null && m.isActive === true;

// A conta abre algum condomínio fora de `managed`? Repor-lhe a password dava-o a quem pede.
export function accountReachableOutside(
  membership: Pick<UserMembership, "activeManagerCondoIds" | "occupantCondoIds">,
  managed: readonly string[],
): boolean {
  return [...membership.activeManagerCondoIds, ...membership.occupantCondoIds]
    .some((cid) => !managed.includes(cid));
}

export function computeUserMembership(rows: MembershipRows): UserMembership {
  const u = rows.user;
  const isSuper = u.role === "super";

  const activeManagerCondoIds = rows.managers
    .filter(isManagerActive)
    .map((m) => m.condominiumId);
  // dedupe (defensivo - schema tem UNIQUE em (cid, user_id) mas se mudar...)
  const dedupedActiveManagerCondoIds = [...new Set(activeManagerCondoIds)];

  const historicManagerCondoIds = [...new Set(rows.managers.map((m) => m.condominiumId))];

  const occupantCondoIds = [...new Set(rows.activeOccupants.map((o) => o.condominiumId))];

  // Pre-index for fast inCondo() lookups.
  const occupantById = new Map(rows.activeOccupants.map((o) => [o.id, o]));

  const inCondo = (cid: string): CondoMembership => {
    const managerRecord = rows.managers.find((m) => m.condominiumId === cid) ?? null;
    const isManager = managerRecord !== null && isManagerActive(managerRecord);
    const hasManagerHistory = managerRecord !== null;

    const activeOccupants = rows.activeOccupants.filter((o) => o.condominiumId === cid);
    const isOccupantOfCondo = activeOccupants.length > 0;

    const condoUnitIds = rows.unitsByCondoId.get(cid) ?? new Set<string>();
    // Filtra unit_occupants para os que (1) apontam para unit existente neste
    // cid e (2) o occupant pertence ao mesmo cid. Da lista, "owned" requer
    // relationshipType='owner'; "linked" aceita qualquer (owner ou tenant).
    const linkedInCondo = rows.activeUnitOccupants.filter((uo) => {
      if (!condoUnitIds.has(uo.unitId)) return false;
      const occ = occupantById.get(uo.occupantId);
      return occ !== undefined && occ.condominiumId === cid;
    });
    const ownedUnitIds = linkedInCondo
      .filter((uo) => uo.relationshipType === "owner")
      .map((uo) => uo.unitId);
    const linkedUnitIds = linkedInCondo.map((uo) => uo.unitId);

    const isCurrentlyRelated = isManager || ownedUnitIds.length > 0;
    const isRelated = hasManagerHistory || isCurrentlyRelated;

    return {
      userId: u.id,
      condominiumId: cid,
      isSuper,
      isManager,
      hasManagerHistory,
      managerRecord,
      activeOccupants,
      isOccupantOfCondo,
      ownedUnitIds,
      linkedUnitIds,
      isCurrentlyRelated,
      isRelated,
    };
  };

  return {
    userId: u.id,
    user: u,
    isSuper,
    activeManagerCondoIds: dedupedActiveManagerCondoIds,
    historicManagerCondoIds,
    occupantCondoIds,
    inCondo,
  };
}
