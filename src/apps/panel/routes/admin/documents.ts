// Routes /admin/c/:cid/documents/*
import type { Hono } from "hono";
import { runFormAction } from "../_form_action.ts";

export function registerDocumentsRoutes(panelRouter: Hono): void {
  panelRouter.get("/admin/c/:cid/documents", async (c) => {
    const { listDocuments } = await import("../../controllers/documents.ts");
    const url = new URL(c.req.url);
    const filter = {
      category: url.searchParams.get("category") || undefined,
      visibility: url.searchParams.get("visibility") || undefined,
    };
    return c.html(await listDocuments(filter));
  });

  panelRouter.post("/admin/c/:cid/documents", (c) =>
    runFormAction(c, async (form) => {
      const { createDocument } = await import("../../controllers/documents.ts");
      const created = await createDocument(form);
      return created;
    }, {
      successPath: (created) => `documents/${(created as { id: string }).id}`,
      errorPath: "documents",
      successMsg: "Documento criado.",
      errorPrefix: "Erro ao criar documento",
    }));

  panelRouter.get("/admin/c/:cid/documents/:id", async (c) => {
    const { showDocument } = await import("../../controllers/documents.ts");
    return c.html(await showDocument(c.req.param("id")));
  });

  panelRouter.post("/admin/c/:cid/documents/:id/update", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const { updateDocument } = await import("../../controllers/documents.ts");
      await updateDocument(id, form);
    }, {
      successPath: `documents/${id}`,
      successMsg: "Documento atualizado.",
      errorPrefix: "Erro ao atualizar documento",
    });
  });

  panelRouter.post("/admin/c/:cid/documents/:id/delete", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async () => {
      const { deleteDocument } = await import("../../controllers/documents.ts");
      await deleteDocument(id);
    }, {
      successPath: "documents",
      errorPath: `documents/${id}`,
      successMsg: "Documento removido.",
      errorPrefix: "Erro ao remover documento",
    });
  });

  // ── Anexos do documento ─────────────────────────────────────────────────
  panelRouter.get(
    "/admin/c/:cid/documents/:id/attachments/:attachmentId",
    async (c) => {
      const { downloadDocumentAttachment } = await import("../../controllers/documents.ts");
      return await downloadDocumentAttachment(c.req.param("id"), c.req.param("attachmentId"));
    },
  );

  panelRouter.post("/admin/c/:cid/documents/:id/attachments", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const file = form.file;
      if (!(file instanceof File)) throw new Error("Ficheiro em falta.");
      const { uploadDocumentAttachment } = await import("../../controllers/documents.ts");
      await uploadDocumentAttachment(id, file);
    }, {
      successPath: `documents/${id}`,
      successMsg: "Anexo carregado.",
      errorPrefix: "Erro ao carregar anexo",
    });
  });

  panelRouter.post(
    "/admin/c/:cid/documents/:id/attachments/:attachmentId/delete",
    (c) => {
      const id = c.req.param("id");
      const attachmentId = c.req.param("attachmentId");
      return runFormAction(c, async () => {
        const { deleteDocumentAttachment } = await import("../../controllers/documents.ts");
        await deleteDocumentAttachment(id, attachmentId);
      }, {
        successPath: `documents/${id}`,
        successMsg: "Anexo removido.",
        errorPrefix: "Erro ao remover anexo",
      });
    },
  );
}
