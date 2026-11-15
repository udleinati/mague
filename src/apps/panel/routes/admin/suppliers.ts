// Routes /admin/c/:cid/suppliers/* - fornecedores.

import type { Hono } from "hono";
import { runFormAction } from "../_form_action.ts";

export function registerSuppliersRoutes(panelRouter: Hono): void {
  panelRouter.get("/admin/c/:cid/suppliers", async (c) => {
    const { listSuppliers } = await import("../../controllers/suppliers.ts");
    return c.html(await listSuppliers());
  });
  panelRouter.post("/admin/c/:cid/suppliers", (c) =>
    runFormAction(c, async (form) => {
      const { createSupplier } = await import("../../controllers/suppliers.ts");
      return await createSupplier(form);
    }, {
      successPath: "suppliers",
      successMsg: "Fornecedor criado.",
      errorPrefix: "Erro ao criar fornecedor",
    }));
  panelRouter.post("/admin/c/:cid/suppliers/:id/update", (c) =>
    runFormAction(c, async (form) => {
      const { updateSupplier } = await import("../../controllers/suppliers.ts");
      return await updateSupplier(c.req.param("id"), form);
    }, {
      successPath: "suppliers",
      successMsg: "Fornecedor atualizado.",
      errorPrefix: "Erro ao atualizar fornecedor",
    }));
  panelRouter.post("/admin/c/:cid/suppliers/:id/delete", (c) =>
    runFormAction(c, async () => {
      const { deleteSupplier } = await import("../../controllers/suppliers.ts");
      return await deleteSupplier(c.req.param("id"));
    }, {
      successPath: "suppliers",
      successMsg: "Fornecedor eliminado.",
      errorPrefix: "Erro ao eliminar fornecedor",
    }));
}
