// Janela do condómino aplicada na API: cobranças, extrato e recibos de períodos
// em que não estava na fração não saem (o token do panel serve de Bearer, por
// isso filtrar só no panel não chegava). Regra pura em `$shared/portal/owner_window.ts`.

import type { Context } from "hono";
import { type SQL, sql } from "drizzle-orm";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { isCondoAdmin } from "$api/libs/shared/require_condo_admin.ts";
import {
  type NestedOccupantUO,
  type OwnerWindow,
  resolveOwnerWindow,
} from "$shared/portal/owner_window.ts";

/** Admin/super do condo vê a fração toda (`null`); o ocupante, o seu período. */
export async function loadPortalOwnerWindow(
  ctx: Context<ApiEnv>,
  postgres: Postgres,
  unitId: string,
): Promise<OwnerWindow | null> {
  if (isCondoAdmin(ctx)) return null;
  const userId = ctx.get("actor")?.user_id ?? null;
  const links = await postgres.query((db) =>
    db.query.unitOccupant.findMany({
      where: (uo, ops) => ops.and(ops.eq(uo.unitId, unitId), ops.isNull(uo.deletedAt)),
      columns: { relationshipType: true, startDate: true, endDate: true },
      with: { occupant: { columns: { id: true, name: true, userId: true, deletedAt: true } } },
    })
  );
  const occupants: NestedOccupantUO[] = links
    .filter((l) => l.occupant && !l.occupant.deletedAt)
    .map((l) => ({
      relationshipType: l.relationshipType,
      startDate: String(l.startDate),
      endDate: l.endDate ? String(l.endDate) : null,
      occupant: { id: l.occupant.id, name: l.occupant.name, userId: l.occupant.userId },
    }));
  return resolveOwnerWindow(occupants, userId ? { id: userId, role: "occupant" } : null);
}

/** `date` (YYYY-MM-DD) dentro da janela; sem data fica de fora. `undefined` = sem filtro. */
export function inOwnerWindowSql(date: SQL, window_: OwnerWindow | null): SQL | undefined {
  if (!window_) return undefined;
  return window_.endDate
    ? sql`(${date}) BETWEEN ${window_.startDate} AND ${window_.endDate}`
    : sql`(${date}) >= ${window_.startDate}`;
}
