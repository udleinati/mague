// Routes /admin/c/:cid/receipts/* - emissão, listagem, void, re-envio email.
//
// /admin/c/:cid/receipts/pending - fila para emitir
// /admin/c/:cid/receipts/emit-to  - modal "Emitir para…" (HTMX)
// /admin/c/:cid/receipts          - histórico (filtros via query string)
// /admin/c/:cid/receipts/:id      - detalhe

import type { Hono } from "hono";
import { runFormAction } from "../_form_action.ts";

export function registerReceiptsRoutes(panelRouter: Hono): void {
  panelRouter.get("/admin/c/:cid/receipts/pending", async (c) => {
    const { pendingPage } = await import("../../controllers/receipts.ts");
    const tab = new URL(c.req.url).searchParams.get("tab") === "skipped" ? "skipped" : "pending";
    return c.html(await pendingPage(tab));
  });
  panelRouter.get("/admin/c/:cid/receipts", async (c) => {
    const { listPage, listFragment } = await import("../../controllers/receipts.ts");
    const params: Record<string, string> = {};
    for (const [k, v] of new URL(c.req.url).searchParams.entries()) params[k] = v;
    if (c.req.header("HX-Request") === "true") {
      return c.html(await listFragment(params));
    }
    return c.html(await listPage(params));
  });
  // Antes de /:id para "emit-to" não ser lido como id.
  panelRouter.get("/admin/c/:cid/receipts/emit-to", async (c) => {
    const { emitToModal } = await import("../../controllers/receipts.ts");
    const q = new URL(c.req.url).searchParams;
    return c.html(
      await emitToModal(q.get("bankTransactionId") ?? "", q.get("unitId") ?? ""),
    );
  });
  panelRouter.get("/admin/c/:cid/receipts/:id", async (c) => {
    const { showPage } = await import("../../controllers/receipts.ts");
    return c.html(await showPage(c.req.param("id")));
  });
  panelRouter.get("/admin/c/:cid/receipts/:id/pdf", async (c) => {
    const { downloadPdf } = await import("../../controllers/receipts.ts");
    return await downloadPdf(c.req.param("id"));
  });
  panelRouter.post("/admin/c/:cid/receipts/emit", async (c) => {
    if (c.req.header("HX-Request") === "true") {
      const { emitOneHtmx } = await import("../../controllers/receipts.ts");
      const form = (await c.req.parseBody()) as Record<string, string | File>;
      return c.html(await emitOneHtmx(form));
    }
    return runFormAction(c, async (form) => {
      const { emitOne } = await import("../../controllers/receipts.ts");
      return await emitOne(form);
    }, {
      successPath: "receipts/pending",
      successMsg: (r) => `Recibo ${(r as { number?: string }).number ?? "?"} emitido.`,
      errorPrefix: "Erro ao emitir",
    });
  });
  // Pré-visualização (read-only): JSON { html } para o iframe do modal (padrão da convocatória).
  panelRouter.post("/admin/c/:cid/receipts/preview", async (c) => {
    const { previewReceipt } = await import("../../controllers/receipts.ts");
    try {
      const form = (await c.req.parseBody()) as Record<string, string | File>;
      return c.json(await previewReceipt(form));
    } catch (err) {
      const { extractApiErrorMessage } = await import("../_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro a gerar a pré-visualização.");
      const safe = msg.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      return c.json({
        html:
          `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;padding:2rem;color:#b91c1c;max-width:40rem;margin:2rem auto;">${safe}</body>`,
      }, 422);
    }
  });
  panelRouter.post("/admin/c/:cid/receipts/skip", async (c) => {
    const { skipReceiptHtmx } = await import("../../controllers/receipts.ts");
    const form = (await c.req.parseBody()) as Record<string, string | File>;
    return c.html(await skipReceiptHtmx(form));
  });
  panelRouter.post("/admin/c/:cid/receipts/unskip", async (c) => {
    const { unskipReceiptHtmx } = await import("../../controllers/receipts.ts");
    const form = (await c.req.parseBody()) as Record<string, string | File>;
    return c.html(await unskipReceiptHtmx(form));
  });
  panelRouter.post("/admin/c/:cid/receipts/emit-bulk", (c) =>
    runFormAction(c, async () => {
      const { emitBulk } = await import("../../controllers/receipts.ts");
      return await emitBulk() as {
        total: number;
        success: number;
        failed: number;
        pendingRemaining: number;
      };
    }, {
      // Quando ainda há pendentes, fica no /pending para continuar; quando o
      // lote esvazia, vai para o /receipts (histórico) onde o user vê os
      // recibos que acabou de emitir.
      successPath: (r) => r.pendingRemaining > 0 ? "receipts/pending" : "receipts",
      errorPath: "receipts/pending",
      successMsg: (r) => {
        const base = `${r.success}/${r.total} emitidos${
          r.failed > 0 ? `, ${r.failed} falharam` : ""
        }`;
        return r.pendingRemaining > 0
          ? `${base}. Faltam ${r.pendingRemaining} - clica em "Emitir lote" outra vez.`
          : `${base}.`;
      },
      successFlashType: (r) => r.failed > 0 ? "warning" : "success",
      errorPrefix: "Erro ao emitir em lote",
    }));
  panelRouter.post("/admin/c/:cid/receipts/:id/void", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const { voidOne } = await import("../../controllers/receipts.ts");
      await voidOne(id, form);
    }, {
      successPath: `receipts/${id}`,
      successMsg: "Recibo anulado.",
      errorPrefix: "Erro ao anular",
    });
  });
  panelRouter.post("/admin/c/:cid/receipts/:id/resend-email", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async () => {
      const { resendEmail } = await import("../../controllers/receipts.ts");
      return await resendEmail(id) as { sent: number; failed: number };
    }, {
      successPath: `receipts/${id}`,
      successMsg: (r) =>
        `${r.sent} email(s) re-enviado(s)${r.failed > 0 ? `, ${r.failed} falharam` : ""}.`,
      successFlashType: (r) => r.failed > 0 ? "warning" : "success",
      errorPrefix: "Erro ao re-enviar",
    });
  });
}
