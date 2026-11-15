import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { createSettlement } from "./create.ts";
import { listSettlements } from "./list.ts";

export const settlementRoutes = () => {
  const route = new Hono<ApiEnv>();

  route.post("/settlements", (ctx) => createSettlement(ctx, postgres));
  route.get("/settlements", (ctx) => listSettlements(ctx, postgres));

  return route;
};
