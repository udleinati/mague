import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { listPaymentPlans } from "./list.ts";
import { createPaymentPlan } from "./create.ts";
import { updatePaymentPlan } from "./update.ts";

export const paymentPlanRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/units/:unitId/payment-plans";

  route.get(basePath, (ctx) => listPaymentPlans(ctx, postgres));
  route.post(basePath, (ctx) => createPaymentPlan(ctx, postgres));
  route.patch(`${basePath}/:planId`, (ctx) => updatePaymentPlan(ctx, postgres));

  return route;
};
