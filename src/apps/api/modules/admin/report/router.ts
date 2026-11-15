import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { cashMovementsReport } from "./cash_movements.ts";
import { cashflowReport } from "./cashflow.ts";
import { assemblyExecutionDetail, assemblyExecutionReport } from "./assembly_execution.ts";

export const reportRoutes = () => {
  const route = new Hono<ApiEnv>();

  route.get("/reports/cash-movements", (ctx) => cashMovementsReport(ctx, postgres));
  route.get("/reports/cashflow", (ctx) => cashflowReport(ctx, postgres));
  route.get("/reports/assembly-execution", (ctx) => assemblyExecutionReport(ctx, postgres));
  route.get(
    "/reports/assembly-execution/:assemblyId",
    (ctx) => assemblyExecutionDetail(ctx, postgres),
  );

  return route;
};
