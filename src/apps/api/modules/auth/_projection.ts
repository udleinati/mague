// Projecções de auth: recebem dados já compostos (não rows), por isso sem
// PROJECTION objects. `formatAuthSessionForResponse` (login) e
// `formatAuthMeForResponse` (me).

import type { UserSelect } from "$api/libs/postgres/schemas/user.ts";
import type { SessionData } from "$api/libs/session/store.ts";

// Resposta do POST /v1/auth/login
export function formatAuthSessionForResponse(
  session: SessionData,
  user: Partial<UserSelect>,
  token: string,
) {
  return {
    // JWT (envelope HS256 do sid). Uso: `Authorization: Bearer <token>`.
    token,
    expiresAt: session.expiresAt,
    user: {
      id: user.id,
      email: user.email ?? null,
      name: user.name,
      role: user.role,
      theme: user.theme ?? null,
      termsAcknowledgedAt: user.termsAcknowledgedAt ? user.termsAcknowledgedAt.toISOString() : null,
    },
  };
}

/** Frações a que o occupant está ligado (vazio para super/admin). Alimenta o
 * redirect pós-login e o switcher de fração no panel. */
export interface OccupantUnitSummary {
  unitId: string;
  condominiumId: string;
  designation: string;
  identifier?: string | null;
  condominiumName?: string;
}

// Resposta do GET /v1/auth/me
export function formatAuthMeForResponse(
  user: Partial<UserSelect>,
  managedCondominiumIds: string[],
  occupantUnits: OccupantUnitSummary[] = [],
) {
  return {
    user: {
      id: user.id,
      email: user.email ?? null,
      name: user.name,
      role: user.role,
      theme: user.theme ?? null,
      termsAcknowledgedAt: user.termsAcknowledgedAt ? user.termsAcknowledgedAt.toISOString() : null,
    },
    managedCondominiumIds,
    occupantUnits,
  };
}
