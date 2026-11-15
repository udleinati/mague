// invite_history - fonte única de "quando foi este user convidado" (filtro
// `purpose='invite'`, evita que tokens de reset poluam o cooldown). Display e
// enforcement lêem o mesmo timestamp; a decisão é a pure function. Ver ADR 0032.

import type { Postgres } from "$api/libs/postgres/postgres.ts";

/**
 * Mapa `userId → created_at` do convite mais recente (`purpose='invite'`).
 * Users sem convite ficam fora do mapa (caller trata como nunca convidado).
 */
export async function loadLastInvitedAt(
  postgres: Postgres,
  userIds: readonly (string | null | undefined)[],
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  // Filtra null/undefined: a listagem agrega managers/occupants sem userId.
  const ids = userIds.filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return out;

  const rows = await postgres.query((db) =>
    db.query.inviteToken.findMany({
      where: (e, ops) =>
        ops.and(
          ops.inArray(e.userId, ids),
          ops.eq(e.purpose, "invite"),
        ),
      columns: { userId: true, createdAt: true },
    })
  );
  for (const r of rows) {
    const prev = out.get(r.userId);
    if (!prev || r.createdAt > prev) out.set(r.userId, r.createdAt);
  }
  return out;
}
