import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { listBudgetLines } from "./list.ts";
import { createBudgetLine } from "./create.ts";
import { updateBudgetLine } from "./update.ts";
import { deleteBudgetLine } from "./delete.ts";

export const budgetLineRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/budgets/:budgetId/lines";

  route.get(basePath, (ctx) => listBudgetLines(ctx, postgres));
  route.post(basePath, (ctx) => createBudgetLine(ctx, postgres));
  route.patch(`${basePath}/:lineId`, (ctx) => updateBudgetLine(ctx, postgres));
  route.delete(`${basePath}/:lineId`, (ctx) => deleteBudgetLine(ctx, postgres));

  return route;
};
