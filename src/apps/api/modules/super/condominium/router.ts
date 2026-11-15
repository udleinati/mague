import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { listCondominiums } from "./list.ts";
import { createCondominium } from "./create.ts";
import { getCondominium } from "./retrieve.ts";
import { updateCondominium } from "./update.ts";
import { deleteCondominium } from "./delete.ts";

export const superCondominiumRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/condominiums";

  route.get(basePath, (ctx) => listCondominiums(ctx, postgres));
  route.post(basePath, (ctx) => createCondominium(ctx, postgres));
  route.get(`${basePath}/:id`, (ctx) => getCondominium(ctx, postgres));
  route.patch(`${basePath}/:id`, (ctx) => updateCondominium(ctx, postgres));
  route.delete(`${basePath}/:id`, (ctx) => deleteCondominium(ctx, postgres));

  return route;
};
