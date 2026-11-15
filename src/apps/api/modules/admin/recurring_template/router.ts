import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { listRecurringTemplates } from "./list.ts";
import { createRecurringTemplate } from "./create.ts";
import { updateRecurringTemplate } from "./update.ts";
import { deleteRecurringTemplate } from "./delete.ts";
import { triggerRecurringGenerationRun } from "./generate_run.ts";

export const recurringTemplateRoutes = () => {
  const route = new Hono<ApiEnv>();
  const basePath = "/recurring_templates";

  route.get(basePath, (ctx) => listRecurringTemplates(ctx, postgres));
  route.post(basePath, (ctx) => createRecurringTemplate(ctx, postgres));

  // /generate ANTES de :templateId, senão é capturado pelo wildcard.
  route.post(`${basePath}/generate`, (ctx) => triggerRecurringGenerationRun(ctx, postgres));

  route.patch(`${basePath}/:templateId`, (ctx) => updateRecurringTemplate(ctx, postgres));
  route.delete(`${basePath}/:templateId`, (ctx) => deleteRecurringTemplate(ctx, postgres));

  return route;
};
