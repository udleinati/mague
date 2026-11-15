// Routes /admin/c/:cid/inspections/* - vistorias regulamentares + anexos.

import type { Context, Hono } from "hono";
import { runFormAction } from "../_form_action.ts";
import { parseFlashFromQuery } from "../_flash.ts";
import { type FlashType, htmxOrRedirect } from "../_htmx_response.ts";

export function registerInspectionsRoutes(panelRouter: Hono): void {
  panelRouter.get("/admin/c/:cid/inspections", async (c) => {
    const { listPage } = await import("../../controllers/admin_inspection.ts");
    return c.html(await listPage(parseFlashFromQuery(c) ?? undefined));
  });

  panelRouter.get("/admin/c/:cid/inspections/new", async (c) => {
    const { newPage } = await import("../../controllers/admin_inspection.ts");
    return c.html(await newPage());
  });

  panelRouter.post("/admin/c/:cid/inspections", (c) =>
    runFormAction(c, async (form) => {
      const { createInspection } = await import("../../controllers/admin_inspection.ts");
      return await createInspection(form);
    }, {
      successPath: (r) => `inspections/${r.id}`,
      successMsg: "Inspeção criada.",
      errorPath: "inspections/new",
      errorPrefix: "Erro a criar inspeção",
    }));

  panelRouter.get("/admin/c/:cid/inspections/:inspectionId", async (c) => {
    const { showPage } = await import("../../controllers/admin_inspection.ts");
    return c.html(await showPage(c.req.param("inspectionId"), parseFlashFromQuery(c) ?? undefined));
  });

  panelRouter.post("/admin/c/:cid/inspections/:inspectionId", (c) => {
    const id = c.req.param("inspectionId");
    return runFormAction(c, async (form) => {
      const { updateInspection } = await import("../../controllers/admin_inspection.ts");
      await updateInspection(id, form);
    }, {
      successPath: `inspections/${id}`,
      successMsg: "Alterações guardadas.",
      errorPrefix: "Erro a guardar",
    });
  });

  panelRouter.post("/admin/c/:cid/inspections/:inspectionId/delete", (c) => {
    const id = c.req.param("inspectionId");
    return runFormAction(c, async () => {
      const { deleteInspection } = await import("../../controllers/admin_inspection.ts");
      await deleteInspection(id);
    }, {
      successPath: "inspections",
      successMsg: "Inspeção apagada.",
      errorPath: `inspections/${id}`,
      errorPrefix: "Erro a apagar",
    });
  });

  panelRouter.post("/admin/c/:cid/inspections/:inspectionId/activate", (c) => {
    const id = c.req.param("inspectionId");
    return runFormAction(c, async () => {
      const { activateInspection } = await import("../../controllers/admin_inspection.ts");
      await activateInspection(id);
    }, {
      successPath: `inspections/${id}`,
      successMsg: "Inspeção ativada.",
      errorPrefix: "Erro a ativar",
    });
  });

  panelRouter.post("/admin/c/:cid/inspections/:inspectionId/deactivate", (c) => {
    const id = c.req.param("inspectionId");
    return runFormAction(c, async () => {
      const { deactivateInspection } = await import("../../controllers/admin_inspection.ts");
      await deactivateInspection(id);
    }, {
      successPath: `inspections/${id}`,
      successMsg: "Inspeção desactivada.",
      errorPrefix: "Erro a desactivar",
    });
  });

  panelRouter.get(
    "/admin/c/:cid/inspections/:inspectionId/attachments/:attachmentId",
    async (c) => {
      const { downloadAttachment } = await import("../../controllers/admin_inspection.ts");
      return await downloadAttachment(c.req.param("inspectionId"), c.req.param("attachmentId"));
    },
  );

  // HTMX-aware: quando vem com `HX-Request: true`, devolve `show.vto` inteiro
  // e o client extrai `#inspection-attachments` via `hx-select`. Sem header,
  // redirect normal com flash. Padrão idêntico ao do ticket (ver tickets.ts).
  const respondInspection = async (
    c: Context,
    id: string,
    message: string,
    flashType: FlashType = "success",
  ): Promise<Response> => {
    return await htmxOrRedirect(c, {
      message,
      flashType,
      redirectPath: `inspections/${id}`,
      renderFragment: async (flash) => {
        const { showPage } = await import("../../controllers/admin_inspection.ts");
        return await showPage(id, flash);
      },
    });
  };

  panelRouter.post("/admin/c/:cid/inspections/:inspectionId/attachments", async (c) => {
    // Multi-file upload: itera sequencial pelos ficheiros do FormData.
    // `runFormAction` não cobre este caso (form record só guarda 1 valor por
    // key); padrão idêntico ao do ticket attachments. Ver ADR 0026.
    const id = c.req.param("inspectionId");
    const fd = await c.req.formData();
    const files = fd.getAll("file")
      .filter((v): v is File => v instanceof File && v.size > 0);
    if (files.length === 0) {
      return await respondInspection(c, id, "Selecciona pelo menos um ficheiro.", "danger");
    }
    try {
      const { addAttachment } = await import("../../controllers/admin_inspection.ts");
      for (const file of files) await addAttachment(id, file);
      const msg = files.length === 1 ? "Anexo carregado." : `${files.length} anexos carregados.`;
      return await respondInspection(c, id, msg, "success");
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)) || "Erro a carregar anexo.";
      return await respondInspection(c, id, msg, "danger");
    }
  });

  panelRouter.post(
    "/admin/c/:cid/inspections/:inspectionId/attachments/:attachmentId/delete",
    async (c) => {
      const id = c.req.param("inspectionId");
      const attId = c.req.param("attachmentId");
      try {
        const { deleteAttachment } = await import("../../controllers/admin_inspection.ts");
        await deleteAttachment(id, attId);
        return await respondInspection(c, id, "Anexo removido.", "success");
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)) || "Erro a remover anexo.";
        return await respondInspection(c, id, msg, "danger");
      }
    },
  );
}
