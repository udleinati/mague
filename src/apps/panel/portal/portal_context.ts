// Single source of truth do contexto da fração ativa no portal (unit +
// occupants, condominium, ownerWindow). `loadPortalUnitContext()` faz
// `getUnit + getCondominium` UMA VEZ e memoiza no slot `_portalCtx` do ALS,
// partilhado entre render.ts (banner) e os 12+ controllers - antes cada um
// fazia o seu fetch e cálculo de ownerWindow, fácil de divergir.

import { client } from "$panel/client.ts";
import { als, currentPortalUnitId, currentUser } from "$panel/context.ts";
import {
  type NestedOccupantUO,
  type OwnerWindow,
  resolveOwnerWindow,
} from "$panel/portal/owner_window.ts";

/** Shape mínimo (contractual) da unit; o payload da API pode ter mais campos. */
export interface PortalUnit extends Record<string, unknown> {
  id: string;
  designation: string;
  identifier?: string | null;
  permillage?: number | string;
  occupants?: NestedOccupantUO[];
  balance?: {
    openDebtCents: number;
    openCreditCents: number;
    overdueDebtCents: number;
    netCents: number;
  };
}

export interface PortalCondominium extends Record<string, unknown> {
  id: string;
  name: string;
  reconciledThroughDate?: string | null;
}

export interface PortalUnitContext {
  unitId: string;
  unit: PortalUnit;
  condominium: PortalCondominium;
  /** Owner window de `unit.occupants` + `currentUser()`; `null` sem owners. */
  ownerWindow: OwnerWindow | null;
}

// Contexto da fração ativa, memoizado per-request via ALS. Throws sem
// `portalUnitId` (só chamado dentro de um portal route).
export function loadPortalUnitContext(): Promise<PortalUnitContext> {
  const store = als.getStore();
  if (!store) throw new Error("loadPortalUnitContext: sem ALS context");
  const unitId = currentPortalUnitId();
  if (!unitId) throw new Error("loadPortalUnitContext: portalUnitId não definido");

  // Lazy: só faz fetch ao primeiro hit.
  if (store._portalCtx) return store._portalCtx as Promise<PortalUnitContext>;

  const promise = (async (): Promise<PortalUnitContext> => {
    const [unitRes, condominiumRes] = await Promise.all([
      client.portal.getUnit(unitId),
      client.portal.getCondominium(),
    ]);
    const unit = unitRes.data as unknown as PortalUnit;
    const condominium = condominiumRes.data as unknown as PortalCondominium;
    const ownerWindow = resolveOwnerWindow(unit.occupants ?? [], currentUser());
    return { unitId, unit, condominium, ownerWindow };
  })();

  store._portalCtx = promise;
  return promise;
}
