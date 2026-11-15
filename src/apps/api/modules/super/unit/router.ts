import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { listUnits } from "./list.ts";
import { createUnit } from "./create.ts";
import { getUnit } from "./retrieve.ts";
import { updateUnit } from "./update.ts";
import { deleteUnit } from "./delete.ts";

export const superUnitRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/condominiums/:id/units";

  route.get(basePath, (ctx) => listUnits(ctx, postgres));
  route.post(basePath, (ctx) => createUnit(ctx, postgres));
  route.get(`${basePath}/:unitId`, (ctx) => getUnit(ctx, postgres));
  route.patch(`${basePath}/:unitId`, (ctx) => updateUnit(ctx, postgres));
  route.delete(`${basePath}/:unitId`, (ctx) => deleteUnit(ctx, postgres));

  return route;
};
