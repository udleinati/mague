import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { listFcrTransfers } from "./list.ts";
import { createFcrTransfer } from "./create.ts";

export const fcrTransferRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/fcr-transfers";

  route.get(basePath, (ctx) => listFcrTransfers(ctx, postgres));
  route.post(basePath, (ctx) => createFcrTransfer(ctx, postgres));

  return route;
};
