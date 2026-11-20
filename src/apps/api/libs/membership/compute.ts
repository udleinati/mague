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
  /** Condos soft-deleted entre os da vinculação: não dão gestão nem portal. */
  deletedCondoIds?: ReadonlySet<string>;
  /** YYYY-MM-DD: ligações com `startDate` posterior ainda não dão portal. Omitido = sem corte. */
  today?: string;
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
   *  tenant) já iniciado (`startDate <= today`). Usado por checks de acesso ao
   *  portal - onde inquilinos têm acesso à sua fração tal como proprietários. */
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
  const deleted = rows.deletedCondoIds ?? new Set<string>();
  // Condo apagado corta o acesso; o registo de manager fica só como histórico.
  const managesLiveCondo = (m: ManagerSelect) =>
    isManagerActive(m) && !deleted.has(m.condominiumId);
  const liveOccupants = rows.activeOccupants.filter((o) => !deleted.has(o.condominiumId));

  const activeManagerCondoIds = rows.managers
    .filter(managesLiveCondo)
    .map((m) => m.condominiumId);
  // dedupe (defensivo - schema tem UNIQUE em (cid, user_id) mas se mudar...)
  const dedupedActiveManagerCondoIds = [...new Set(activeManagerCondoIds)];

  const historicManagerCondoIds = [...new Set(rows.managers.map((m) => m.condominiumId))];

  const occupantCondoIds = [...new Set(liveOccupants.map((o) => o.condominiumId))];

  // Pre-index for fast inCondo() lookups.
  const occupantById = new Map(liveOccupants.map((o) => [o.id, o]));

  const inCondo = (cid: string): CondoMembership => {
    const managerRecord = rows.managers.find((m) => m.condominiumId === cid) ?? null;
    const isManager = managerRecord !== null && managesLiveCondo(managerRecord);
    const hasManagerHistory = managerRecord !== null;

    const activeOccupants = liveOccupants.filter((o) => o.condominiumId === cid);
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
    // Comprador registado antes da escritura não entra no portal antes do início.
    const linkedUnitIds = linkedInCondo
      .filter((uo) => !rows.today || String(uo.startDate) <= rows.today)
      .map((uo) => uo.unitId);

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
