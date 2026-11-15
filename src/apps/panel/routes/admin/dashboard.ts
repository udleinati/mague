// Routes /admin/c/:cid/dashboard - landing do admin do condomínio.

import type { Hono } from "hono";
import { dashboard } from "../../controllers/dashboard.ts";

export function registerDashboardRoutes(panelRouter: Hono): void {
  panelRouter.get("/admin/c/:cid/dashboard", async (c) => {
    const html = await dashboard();
    return c.html(html);
  });
}
