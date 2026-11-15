// Projection partilhada pelos handlers de users (ver charge/_projection.ts).

import type { UserSelect } from "$api/libs/postgres/schemas/user.ts";
import { inviteCooldownEndsAt, isInInviteResendCooldown } from "$shared/auth/invite_eligibility.ts";

// Sem nif/phone no user - vivem em core.occupant.
const USER_TOP_LEVEL_COLUMNS = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  passwordChangedAt: true,
  failedLoginAttempts: true,
  lastFailedLoginAt: true,
  lastLoginAt: true,
  firstLoginAt: true,
} as const;

export const USER_PROJECTION = {
  columns: USER_TOP_LEVEL_COLUMNS,
} as const;

type UserRowLike = Partial<UserSelect>;

/** Snapshot de uma ligação user↔fração para uso nas listagens admin. */
export interface UserUnitSummary {
  unitId: string;
  designation: string;
  identifier: string | null;
  relationshipType: string; // "owner" | "tenant" | "resident"
}

export function formatUserForResponse(
  row: UserRowLike,
  isManager?: boolean,
  occupantId?: string | null,
  lastInvitedAt?: Date | null,
  units?: UserUnitSummary[],
) {
  const last = lastInvitedAt ?? null;
  const inviteInCooldown = isInInviteResendCooldown(last, new Date());
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // Segurança da password: UI mostra última troca + falhas.
    passwordChangedAt: row.passwordChangedAt ?? null,
    failedLoginAttempts: row.failedLoginAttempts ?? 0,
    lastFailedLoginAt: row.lastFailedLoginAt ?? null,
    lastLoginAt: row.lastLoginAt ?? null,
    firstLoginAt: row.firstLoginAt ?? null,
    // Derivado de `core.manager` para o cid do request. Ver ADR 0002.
    isManager: isManager ?? false,
    // ID do `core.occupant` deste user NESTE condo. Null = admin-only.
    // Endpoint de invite: `/occupants/:occId/invite`.
    occupantId: occupantId ?? null,
    // Invite mais recente (qualquer purpose). Null = nunca convidado; permite
    // ao UI distinguir "convidar" (1º envio) de "reenviar".
    lastInvitedAt: lastInvitedAt ?? null,
    // Cooldown de reenvio (ADR 0032): derivado de `lastInvitedAt` pela mesma
    // pure function do enforcement (422 COOLDOWN_ACTIVE), nunca divergem.
    // `inviteCooldownUntil` (ISO, só em cooldown) = quando termina.
    inviteInCooldown,
    inviteCooldownUntil: inviteInCooldown
      ? (inviteCooldownEndsAt(last)?.toISOString() ?? null)
      : null,
    // Frações deste user NESTE condo (qualquer relationship). Vazio = admin-only.
    units: units ?? [],
  };
}
