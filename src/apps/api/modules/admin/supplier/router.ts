import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { listSuppliers } from "./list.ts";
import { createSupplier } from "./create.ts";
import { getSupplier } from "./retrieve.ts";
import { updateSupplier } from "./update.ts";
import { deleteSupplier } from "./delete.ts";

export const supplierRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/suppliers";

  route.get(basePath, (ctx) => listSuppliers(ctx, postgres));
  route.post(basePath, (ctx) => createSupplier(ctx, postgres));
  route.get(`${basePath}/:supplierId`, (ctx) => getSupplier(ctx, postgres));
  route.patch(`${basePath}/:supplierId`, (ctx) => updateSupplier(ctx, postgres));
  route.delete(`${basePath}/:supplierId`, (ctx) => deleteSupplier(ctx, postgres));

  return route;
};
