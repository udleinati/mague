import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { listBudgets } from "./list.ts";
import { getBudget } from "./retrieve.ts";
import { createBudget } from "./create.ts";
import { updateBudget } from "./update.ts";
import { deleteBudget } from "./delete.ts";
import { rejectBudget } from "./reject.ts";
import { reopenBudget } from "./reopen.ts";
import { generateQuotas } from "./generate_quotas.ts";
import { getBudgetQuotaMap } from "./quota_map.ts";
import { getBudgetPdf } from "./pdf.ts";

export const budgetRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/budgets";

  route.get(basePath, (ctx) => listBudgets(ctx, postgres));
  route.post(basePath, (ctx) => createBudget(ctx, postgres));
  route.get(`${basePath}/:budgetId`, (ctx) => getBudget(ctx, postgres));
  route.patch(`${basePath}/:budgetId`, (ctx) => updateBudget(ctx, postgres));
  route.delete(`${basePath}/:budgetId`, (ctx) => deleteBudget(ctx, postgres));
  // Marcação manual de proposta preterida (draft <-> not_approved). A aprovação
  // continua exclusiva da assembleia (não há rota para virar 'approved' aqui).
  route.post(`${basePath}/:budgetId/reject`, (ctx) => rejectBudget(ctx, postgres));
  route.post(`${basePath}/:budgetId/reopen`, (ctx) => reopenBudget(ctx, postgres));
  // Aprovação só via decisão de assembleia:
  // POST /assemblies/:assemblyId/agenda-items com itemType='approve_budget'
  route.post(`${basePath}/:budgetId/generate_quotas`, (ctx) => generateQuotas(ctx, postgres));
  route.get(`${basePath}/:budgetId/quota_map`, (ctx) => getBudgetQuotaMap(ctx, postgres));
  route.get(`${basePath}/:budgetId/pdf`, (ctx) => getBudgetPdf(ctx, postgres));

  return route;
};
