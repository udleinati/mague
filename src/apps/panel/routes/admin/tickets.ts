// Routes /admin/c/:cid/tickets/* - ocorrências: CRUD + comments + anexos.
// Híbrido: CRUD/navegação = redirect + flash; update/comments/attachments =
// HTMX-aware (partial OOB + toast, preserva scroll). Espelha assembly.ts.

import type { Context, Hono } from "hono";
import { runFormAction } from "../_form_action.ts";
import { htmxOrRedirect } from "../_htmx_response.ts";
import { parseFlashFromQuery } from "../_flash.ts";
import { condoUrl } from "../../urls.ts";

export function registerTicketsRoutes(panelRouter: Hono): void {
  // HTMX-aware via htmxOrRedirect (ADR 0030): fixa `renderTicketBody` e redirectPath.
  const respondTicket = (
    c: Context,
    id: string,
    message: string,
  ): Promise<Response> =>
    htmxOrRedirect(c, {
      renderFragment: async () => {
        const { renderTicketBody } = await import("../../controllers/admin_ticket.ts");
        return await renderTicketBody(id, { message });
      },
      redirectPath: `tickets/${id}`,
      message,
    });

  panelRouter.get("/admin/c/:cid/tickets", async (c) => {
    const { listPage } = await import("../../controllers/admin_ticket.ts");
    const url = new URL(c.req.url);
    const params: Record<string, string> = {};
    for (const k of ["status", "category", "priority", "unitId"]) {
      const v = url.searchParams.get(k);
      if (v) params[k] = v;
    }
    return c.html(await listPage(params, parseFlashFromQuery(c) ?? undefined));
  });

  panelRouter.get("/admin/c/:cid/tickets/new", async (c) => {
    const { newPage } = await import("../../controllers/admin_ticket.ts");
    return c.html(await newPage());
  });

  panelRouter.post("/admin/c/:cid/tickets", (c) =>
    runFormAction(c, async (form) => {
      const { createTicket } = await import("../../controllers/admin_ticket.ts");
      return await createTicket(form);
    }, {
      successPath: (t) => `tickets/${t.id}`,
      successMsg: "Ocorrência criada.",
      errorPath: "tickets/new",
      errorPrefix: "Erro a criar ocorrência",
    }));

  panelRouter.get("/admin/c/:cid/tickets/:ticketId", async (c) => {
    const { showPage } = await import("../../controllers/admin_ticket.ts");
    return c.html(await showPage(c.req.param("ticketId"), parseFlashFromQuery(c) ?? undefined));
  });

  // ── HTMX-aware: partial swap em vez de full reload ──────────────────────
  panelRouter.post("/admin/c/:cid/tickets/:ticketId/update", async (c) => {
    const id = c.req.param("ticketId");
    const body = await c.req.parseBody();
    const { updateTicket } = await import("../../controllers/admin_ticket.ts");
    await updateTicket(id, body as Record<string, string | File>);
    return await respondTicket(c, id, "Ocorrência atualizada.");
  });

  panelRouter.post("/admin/c/:cid/tickets/:ticketId/comments", async (c) => {
    const id = c.req.param("ticketId");
    const body = await c.req.parseBody();
    const { addComment } = await import("../../controllers/admin_ticket.ts");
    await addComment(id, body as Record<string, string | File>);
    return await respondTicket(c, id, "Comentário adicionado.");
  });

  panelRouter.post(
    "/admin/c/:cid/tickets/:ticketId/comments/:commentId/delete",
    async (c) => {
      const id = c.req.param("ticketId");
      const commentId = c.req.param("commentId");
      const { deleteComment } = await import("../../controllers/admin_ticket.ts");
      await deleteComment(id, commentId);
      return await respondTicket(c, id, "Comentário removido.");
    },
  );

  // Promover ticket → patologia (ADR 0024). Cria patologia
  // pré-preenchida + linka ao ticket. Redireccciona para a patologia nova.
  panelRouter.post("/admin/c/:cid/tickets/:ticketId/promote-to-pathology", (c) => {
    const id = c.req.param("ticketId");
    return runFormAction(c, async (form) => {
      const { promoteTicketToPathology } = await import(
        "../../controllers/admin_ticket.ts"
      );
      return await promoteTicketToPathology(id, form);
    }, {
      successPath: (r) => `pathologies/${(r as { pathologyId: string }).pathologyId}`,
      errorPath: `tickets/${id}`,
      successMsg: (r) =>
        `Patologia ${
          (r as { pathologyCode: string }).pathologyCode
        } criada e ligada a este ticket.`,
      errorPrefix: "Erro ao promover ticket a patologia",
    });
  });

  // Delete ticket - sai da página para a lista; mantém redirect normal.
  panelRouter.post("/admin/c/:cid/tickets/:ticketId/delete", (c) => {
    const id = c.req.param("ticketId");
    return runFormAction(c, async () => {
      const { deleteTicket } = await import("../../controllers/admin_ticket.ts");
      await deleteTicket(id);
    }, {
      successPath: "tickets",
      successMsg: "Ocorrência apagada.",
      errorPath: `tickets/${id}`,
      errorPrefix: "Erro a apagar",
    });
  });

  // Attachments
  panelRouter.get("/admin/c/:cid/tickets/:ticketId/attachments/:attachmentId", async (c) => {
    // Proxy direto à API (que serve os bytes do S3). Auth via default headers
    // do client partilhado; cid resolvido do path pelo ALS.
    const ticketId = c.req.param("ticketId");
    const attId = c.req.param("attachmentId");
    const { proxyDownload } = await import("../../libs/download_proxy.ts");
    const { client } = await import("../../client.ts");
    const upstream = await client.admin.downloadStream(
      `/tickets/${ticketId}/attachments/${attId}`,
    );
    return proxyDownload(upstream);
  });

  // Upload multi-ficheiro (HTMX-aware). Lê via `getAll("files")` (parseBody
  // colapsava ao último); itera sequencial porque a API aceita 1 file/chamada.
  panelRouter.post("/admin/c/:cid/tickets/:ticketId/attachments", async (c) => {
    const id = c.req.param("ticketId");
    const fd = await c.req.formData();
    const files = fd.getAll("files")
      .filter((v): v is File => v instanceof File && v.size > 0);
    if (files.length === 0) {
      const errUrl = condoUrl(
        `tickets/${id}?flash=${
          encodeURIComponent("Seleciona pelo menos um ficheiro.")
        }&flashType=danger`,
      );
      if (c.req.header("HX-Request") === "true") {
        return c.body(null, 200, { "HX-Redirect": errUrl });
      }
      return c.redirect(errUrl);
    }
    const { uploadAttachment } = await import("../../controllers/admin_ticket.ts");
    for (const file of files) {
      await uploadAttachment(id, file);
    }
    const msg = files.length === 1 ? "Anexo carregado." : `${files.length} anexos carregados.`;
    return await respondTicket(c, id, msg);
  });

  panelRouter.post(
    "/admin/c/:cid/tickets/:ticketId/attachments/:attachmentId/delete",
    async (c) => {
      const id = c.req.param("ticketId");
      const attId = c.req.param("attachmentId");
      const { deleteAttachment } = await import("../../controllers/admin_ticket.ts");
      await deleteAttachment(id, attId);
      return await respondTicket(c, id, "Anexo removido.");
    },
  );
}
