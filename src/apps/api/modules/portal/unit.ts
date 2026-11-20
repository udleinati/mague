// GET /v1/portal/condominiums/:cid/units/:uid - metadata da fração + balance +
// occupants. Wrapper read-only do `getUnit` admin (auth por requirePortalAccessToUnit).

import type { Context } from "hono";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { getMeUnit } from "$api/modules/admin/unit/retrieve.ts";
import { isCondoAdmin } from "$api/libs/shared/require_condo_admin.ts";

export const portalGetUnit = (ctx: Context, postgres: Postgres) => {
  return getMeUnit(ctx, postgres, { onlyCurrentOccupants: !isCondoAdmin(ctx) });
};
