// Routes /admin/c/:cid/reports/* - relatórios agregados (só leitura).

import type { Hono } from "hono";

export function registerReportsRoutes(panelRouter: Hono): void {
  panelRouter.get("/admin/c/:cid/reports/movements", async (c) => {
    const { movementsReport } = await import("../../controllers/reports.ts");
    return c.html(
      await movementsReport({
        year: c.req.query("year"),
        bolsa: c.req.query("bolsa"),
        month: c.req.query("month"),
      }),
    );
  });

  panelRouter.get("/admin/c/:cid/reports/cashflow", async (c) => {
    const { cashflowReport } = await import("../../controllers/reports.ts");
    return c.html(await cashflowReport({ months: c.req.query("months") }));
  });

  panelRouter.get("/admin/c/:cid/reports/assemblies", async (c) => {
    const { assembliesReport } = await import("../../controllers/reports.ts");
    return c.html(await assembliesReport());
  });

  panelRouter.get("/admin/c/:cid/reports/assemblies/:id", async (c) => {
    const { assemblyReportShow } = await import("../../controllers/reports.ts");
    return c.html(await assemblyReportShow(c.req.param("id")));
  });
}
