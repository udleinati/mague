import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { requireUnitInCondo } from "$api/middleware/require_unit_in_condo.ts";
import { listUnitOccupants } from "./list.ts";
import { getUnitOccupant } from "./retrieve.ts";
import { createUnitOccupant } from "./create.ts";
import { updateUnitOccupant } from "./update.ts";
import { deleteUnitOccupant } from "./delete.ts";
import { deleteUnitOccupantByOccupant } from "./delete_by_occupant.ts";

export const unitOccupantRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/units/:unitId/occupants";

  // unit_occupant não tem condominiumId próprio: o gate de tenant recai sobre a fração.
  route.use(basePath, requireUnitInCondo());
  route.use(`${basePath}/*`, requireUnitInCondo());

  route.get(basePath, (ctx) => listUnitOccupants(ctx, postgres));
  route.get(`${basePath}/:unitOccupantId`, (ctx) => getUnitOccupant(ctx, postgres));
  route.post(basePath, (ctx) => createUnitOccupant(ctx, postgres));
  route.patch(`${basePath}/:unitOccupantId`, (ctx) => updateUnitOccupant(ctx, postgres));
  route.delete(`${basePath}/:unitOccupantId`, (ctx) => deleteUnitOccupant(ctx, postgres));

  // Delete by occupantId instead of unitOccupantId
  route.delete(
    `${basePath}/by-occupant/:occupantId`,
    (ctx) => deleteUnitOccupantByOccupant(ctx, postgres),
  );
  // Convite movido para `/admin/c/:cid/occupants/:occId/invite` (router de
  // occupant) - não exige `unitId`. Ver invite_by_occupant.ts.

  return route;
};
