// Routes /admin/c/:cid/recurring/* - templates de despesas recorrentes.

import type { Hono } from "hono";
import { runFormAction } from "../_form_action.ts";

export function registerRecurringRoutes(panelRouter: Hono): void {
  panelRouter.get("/admin/c/:cid/recurring", async (c) => {
    const { listRecurring } = await import("../../controllers/recurring.ts");
    return c.html(await listRecurring());
  });
  panelRouter.post("/admin/c/:cid/recurring", (c) =>
    runFormAction(c, async (form) => {
      const { createTemplate } = await import("../../controllers/recurring.ts");
      return await createTemplate(form);
    }, {
      successPath: "recurring",
      successMsg: "Template criado.",
      errorPrefix: "Erro ao criar template",
    }));
  panelRouter.post("/admin/c/:cid/recurring/generate", (c) =>
    runFormAction(c, async (form) => {
      const { triggerRun } = await import("../../controllers/recurring.ts");
      return await triggerRun(form);
    }, {
      successPath: "charges?kind=payable",
      successMsg: "Cobranças geradas.",
      errorPrefix: "Erro ao gerar cobranças",
    }));
  panelRouter.post("/admin/c/:cid/recurring/:id/update", (c) =>
    runFormAction(c, async (form) => {
      const { updateTemplate } = await import("../../controllers/recurring.ts");
      return await updateTemplate(c.req.param("id"), form);
    }, {
      successPath: "recurring",
      successMsg: "Template atualizado.",
      errorPrefix: "Erro ao atualizar template",
    }));
  panelRouter.post("/admin/c/:cid/recurring/:id/toggle", (c) =>
    runFormAction(c, async (form) => {
      const { toggleTemplate } = await import("../../controllers/recurring.ts");
      return await toggleTemplate(c.req.param("id"), String(form.isActive) === "true");
    }, {
      successPath: "recurring",
      successMsg: "Estado do template alterado.",
      errorPrefix: "Erro ao alterar estado",
    }));
  panelRouter.post("/admin/c/:cid/recurring/:id/delete", (c) =>
    runFormAction(c, async () => {
      const { deleteTemplate } = await import("../../controllers/recurring.ts");
      return await deleteTemplate(c.req.param("id"));
    }, {
      successPath: "recurring",
      successMsg: "Template eliminado.",
      errorPrefix: "Erro ao eliminar template",
    }));
}
