// WHERE canónico "esta entidade por id, neste condo, não apagada": junta as 3
// invariantes (id + tenant gate ADR 0009 + soft-delete ADR 0005) repetidas em
// ~44 handlers admin. Mudança à invariante edita-se aqui, não em 44 sites.

import { and, eq, isNull, type SQL } from "drizzle-orm";

/**
 * WHERE `id = $1 AND condominium_id = $2 AND deleted_at IS NULL`. Serve tanto
 * `findFirst({ where })` como `update/delete().where(...)` do Drizzle.
 */
export function byIdInCondo<
  T extends {
    // deno-lint-ignore no-explicit-any
    id: any;
    // deno-lint-ignore no-explicit-any
    condominiumId: any;
    // deno-lint-ignore no-explicit-any
    deletedAt: any;
  },
>(
  table: T,
  id: string,
  condominiumId: string,
): SQL {
  return and(
    eq(table.id, id),
    eq(table.condominiumId, condominiumId),
    isNull(table.deletedAt),
  )!;
}
