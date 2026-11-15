import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { listChartOfAccounts } from "./list.ts";
import { getChartOfAccount } from "./retrieve.ts";
import { createChartOfAccount } from "./create.ts";
import { updateChartOfAccount } from "./update.ts";
import { deleteChartOfAccount } from "./delete.ts";

export const chartOfAccountRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/chart_of_accounts";

  route.get(basePath, (ctx) => listChartOfAccounts(ctx, postgres));
  route.post(basePath, (ctx) => createChartOfAccount(ctx, postgres));
  route.get(`${basePath}/:accountId`, (ctx) => getChartOfAccount(ctx, postgres));
  route.patch(`${basePath}/:accountId`, (ctx) => updateChartOfAccount(ctx, postgres));
  route.delete(`${basePath}/:accountId`, (ctx) => deleteChartOfAccount(ctx, postgres));

  return route;
};
