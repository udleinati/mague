// Router do módulo Lembrete de cobrança (ADR 0028).

import { Hono } from "hono";
import type { ApiEnv } from "$api/middleware/api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { requireUnitInCondo } from "$api/middleware/require_unit_in_condo.ts";
import {
  listOverdueHandler,
  previewBillingReminderHandler,
  sendBillingReminderHandler,
} from "./handlers.ts";

export const billingReminderRoutes = () => {
  const route = new Hono<ApiEnv>();
  const base = "/billing-reminders";

  route.get(`${base}/overdue`, (ctx) => listOverdueHandler(ctx, postgres));
  route.get(
    `${base}/units/:unitId/preview`,
    requireUnitInCondo(),
    (ctx) => previewBillingReminderHandler(ctx, postgres),
  );
  route.post(
    `${base}/units/:unitId`,
    requireUnitInCondo(),
    (ctx) => sendBillingReminderHandler(ctx, postgres),
  );

  return route;
};
