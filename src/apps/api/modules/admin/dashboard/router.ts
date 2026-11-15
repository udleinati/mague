import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { dashboardMetrics } from "./metrics.ts";

export const dashboardRoutes = () => {
  const route = new Hono<ApiEnv>();

  route.get("/dashboard/metrics", (ctx) => dashboardMetrics(ctx, postgres));

  return route;
};
