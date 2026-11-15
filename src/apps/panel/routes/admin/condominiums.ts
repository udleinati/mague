// Routes /admin/c/:cid/condominiums/* - vista admin do(s) condomínio(s).

import type { Hono } from "hono";
import { runFormAction } from "../_form_action.ts";
import { parseFlashFromQuery } from "../_flash.ts";
import { getCondominium, listCondominiums } from "../../controllers/condominiums.ts";

export function registerCondominiumsRoutes(panelRouter: Hono): void {
  panelRouter.get("/admin/c/:cid/condominiums", async (c) => {
    const html = await listCondominiums();
    return c.html(html);
  });

  // Antes de `/:id`, senão "new" é apanhado como id.
  panelRouter.get("/admin/c/:cid/condominiums/new", async (c) => {
    const { newCondominiumPage } = await import("../../controllers/condominiums.ts");
    return c.html(await newCondominiumPage());
  });

  panelRouter.post("/admin/c/:cid/condominiums", (c) =>
    runFormAction(c, async (form) => {
      const { createCondominium } = await import("../../controllers/condominiums.ts");
      return await createCondominium(form);
    }, {
      successPath: (r) => `condominiums/${r.id}`,
      successMsg: "Condomínio criado.",
      errorPath: "condominiums/new",
      errorPrefix: "Erro ao criar condomínio",
    }));

  panelRouter.get("/admin/c/:cid/condominiums/:id", async (c) => {
    const html = await getCondominium(c.req.param("id"), parseFlashFromQuery(c));
    return c.html(html);
  });

  panelRouter.get("/admin/c/:cid/condominiums/:id/edit", async (c) => {
    const { getEditCondominium } = await import("../../controllers/condominiums.ts");
    return c.html(await getEditCondominium(c.req.param("id"), parseFlashFromQuery(c)));
  });

  panelRouter.post("/admin/c/:cid/condominiums/:id/update", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const { updateCondominium } = await import("../../controllers/condominiums.ts");
      await updateCondominium(id, form);
    }, {
      successPath: `condominiums/${id}`,
      successMsg: "Condomínio atualizado.",
      errorPath: `condominiums/${id}/edit`,
      errorPrefix: "Erro ao atualizar",
    });
  });
}
