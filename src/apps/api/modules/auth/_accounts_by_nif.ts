// Contas ativas com este NIF. O NIF vive no ocupante de cada condomínio e a conta é por
// email: a mesma pessoa com emails diferentes em dois condomínios tem duas contas.

import type { Postgres } from "$api/libs/postgres/postgres.ts";
import type { UserSelect } from "$api/libs/postgres/schemas/user.ts";

export async function findActiveUsersByNif(
  postgres: Postgres,
  nif: string,
): Promise<UserSelect[]> {
  const occupants = await postgres.query((db) =>
    db.query.occupant.findMany({
      where: (o, ops) =>
        ops.and(
          ops.eq(o.nif, nif),
          ops.isNotNull(o.userId),
          ops.isNull(o.deletedAt),
        ),
      columns: { userId: true },
    })
  );
  const userIds = [...new Set(occupants.map((o) => o.userId!))];
  if (userIds.length === 0) return [];
  return await postgres.query((db) =>
    db.query.user.findMany({
      where: (u, ops) =>
        ops.and(
          ops.inArray(u.id, userIds),
          ops.eq(u.isActive, true),
          ops.isNull(u.deletedAt),
        ),
      orderBy: (u, { asc }) => asc(u.createdAt),
    })
  );
}
