// Routes /admin/c/:cid/reconciliation/* - bank reconciliation + allocation
// + reverse. A maioria dos handlers tem dual mode (HTMX swap vs full reload).

import type { Hono } from "hono";
import { condoUrl } from "../../urls.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { runFormAction } from "../_form_action.ts";

export function registerReconciliationRoutes(panelRouter: Hono): void {
  // Legacy: /bank → /reconciliation. Cada tab guarda o cid na URL.
  panelRouter.get("/admin/c/:cid/bank", (c) => c.redirect(condoUrl("reconciliation")));

  panelRouter.get("/admin/c/:cid/reconciliation", async (c) => {
    const { reconciliationPage, reconciliationFragment } = await import(
      "../../controllers/reconciliation.ts"
    );
    const params: Record<string, string> = {};
    for (const [k, v] of new URL(c.req.url).searchParams.entries()) params[k] = v;
    if (c.req.header("HX-Request") === "true") {
      return c.html(await reconciliationFragment(params));
    }
    return c.html(await reconciliationPage(params));
  });
  // POST /admin/c/:cid/reconciliation/cutoff - define a data até à qual
  // está conciliado. Driver da view v_unit_balance (overdue) e do banner
  // no portal do condómino. Form aceita `_clear=1` para anular.
  panelRouter.post("/admin/c/:cid/reconciliation/cutoff", (c) =>
    runFormAction(c, async (form) => {
      const { setReconciliationCutoff } = await import("../../controllers/reconciliation.ts");
      await setReconciliationCutoff(form);
    }, {
      successPath: "reconciliation",
      successMsg: "Cutoff atualizado.",
      errorPrefix: "Erro ao atualizar cutoff",
    }));
  // Lazy-load do modal via HTMX - o botão "conciliar" faz hx-get aqui e o
  // HTML do modal único é injectado no placeholder da página.
  panelRouter.get("/admin/c/:cid/reconciliation/tx/:txId/modal", async (c) => {
    const { renderTxModal } = await import("../../controllers/reconciliation.ts");
    const txId = c.req.param("txId");
    return c.html(await renderTxModal(txId));
  });
  // Preview (dry-run) da imputação por fração - HTMX carrega ao escolher fração
  // ou mudar o filtro de tipo (chargeTypeFilter). Read-only, não muta nada.
  panelRouter.get("/admin/c/:cid/reconciliation/tx/:txId/allocation-preview", async (c) => {
    const { renderAllocationPreview } = await import("../../controllers/reconciliation.ts");
    const txId = c.req.param("txId");
    const url = new URL(c.req.url);
    const unitId = url.searchParams.get("unitId") ?? "";
    const filter = url.searchParams.get("chargeTypeFilter") ?? "all";
    return c.html(await renderAllocationPreview(txId, unitId, filter));
  });
  panelRouter.post("/admin/c/:cid/reconciliation/reconcile", async (c) => {
    const { reconcile, renderTxUpdate } = await import("../../controllers/reconciliation.ts");
    const form = await c.req.parseBody() as Record<string, string | File>;
    const bankTxId = parseFormString(form, "bankTransactionId");
    const isHtmx = c.req.header("HX-Request") === "true";
    try {
      const r = await reconcile(form);
      if (isHtmx) {
        const message = r.count === 1 ? "1 charge conciliada." : `${r.count} charges conciliadas.`;
        return c.html(await renderTxUpdate(bankTxId, { type: "success", message }));
      }
      return c.redirect(condoUrl("reconciliation"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro";
      if (isHtmx) return c.html(await renderTxUpdate(bankTxId, { type: "error", message: msg }));
      return c.redirect(
        condoUrl(`reconciliation?flash=${encodeURIComponent(msg)}&flashType=danger`),
      );
    }
  });
  panelRouter.post("/admin/c/:cid/reconciliation/adjust-reconcile", async (c) => {
    const { adjustChargeAndReconcile, renderTxUpdate } = await import(
      "../../controllers/reconciliation.ts"
    );
    const form = await c.req.parseBody() as Record<string, string | File>;
    const bankTxId = parseFormString(form, "bankTransactionId");
    const isHtmx = c.req.header("HX-Request") === "true";
    try {
      await adjustChargeAndReconcile(form);
      if (isHtmx) {
        return c.html(
          await renderTxUpdate(bankTxId, {
            type: "success",
            message: "Charge ajustada e conciliada.",
          }),
        );
      }
      return c.redirect(condoUrl("reconciliation"));
    } catch (err) {
      const { extractApiErrorMessage } = await import("../_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro ao ajustar + conciliar");
      if (isHtmx) return c.html(await renderTxUpdate(bankTxId, { type: "error", message: msg }));
      return c.redirect(
        condoUrl(`reconciliation?flash=${encodeURIComponent(msg)}&flashType=danger`),
      );
    }
  });
  panelRouter.post("/admin/c/:cid/reconciliation/allocate-unit", async (c) => {
    const { allocateToUnit, renderTxUpdate } = await import("../../controllers/reconciliation.ts");
    const form = await c.req.parseBody() as Record<string, string | File>;
    const bankTxId = parseFormString(form, "bankTransactionId");
    const isHtmx = c.req.header("HX-Request") === "true";
    try {
      const r = await allocateToUnit(form);
      const message = `Imputado em ${r.allocations.length} charge(s).`;
      if (isHtmx) return c.html(await renderTxUpdate(bankTxId, { type: "success", message }));
      return c.redirect(
        condoUrl(`reconciliation?flash=${encodeURIComponent(message)}&flashType=success`),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro";
      if (isHtmx) return c.html(await renderTxUpdate(bankTxId, { type: "error", message: msg }));
      return c.redirect(
        condoUrl(`reconciliation?flash=${encodeURIComponent(msg)}&flashType=danger`),
      );
    }
  });
  panelRouter.post("/admin/c/:cid/reconciliation/allocate-supplier", async (c) => {
    const { allocateToSupplier, renderTxUpdate } = await import(
      "../../controllers/reconciliation.ts"
    );
    const form = await c.req.parseBody() as Record<string, string | File>;
    const bankTxId = parseFormString(form, "bankTransactionId");
    const isHtmx = c.req.header("HX-Request") === "true";
    try {
      const r = await allocateToSupplier(form);
      const message = `Imputado em ${r.allocations.length} fatura(s).`;
      if (isHtmx) return c.html(await renderTxUpdate(bankTxId, { type: "success", message }));
      return c.redirect(
        condoUrl(`reconciliation?flash=${encodeURIComponent(message)}&flashType=success`),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro";
      if (isHtmx) return c.html(await renderTxUpdate(bankTxId, { type: "error", message: msg }));
      return c.redirect(
        condoUrl(`reconciliation?flash=${encodeURIComponent(msg)}&flashType=danger`),
      );
    }
  });

  // Devolução de fornecedor: cria charge payable+credit + settlement
  // bank_reconciliation num atom via o endpoint dedicado da API.
  panelRouter.post("/admin/c/:cid/reconciliation/refund-supplier", async (c) => {
    const { allocateSupplierRefund, renderTxUpdate } = await import(
      "../../controllers/reconciliation.ts"
    );
    const form = await c.req.parseBody() as Record<string, string | File>;
    const bankTxId = parseFormString(form, "bankTransactionId");
    const isHtmx = c.req.header("HX-Request") === "true";
    try {
      await allocateSupplierRefund(form);
      const message = "Devolução registada.";
      if (isHtmx) return c.html(await renderTxUpdate(bankTxId, { type: "success", message }));
      return c.redirect(
        condoUrl(`reconciliation?flash=${encodeURIComponent(message)}&flashType=success`),
      );
    } catch (err) {
      const { extractApiErrorMessage } = await import("../_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro ao registar devolução");
      if (isHtmx) return c.html(await renderTxUpdate(bankTxId, { type: "error", message: msg }));
      return c.redirect(
        condoUrl(`reconciliation?flash=${encodeURIComponent(msg)}&flashType=danger`),
      );
    }
  });

  // Ignorar (ou retomar) uma bank_tx. HTMX faz swap OOB do row + toast.
  panelRouter.post("/admin/c/:cid/reconciliation/tx/:txId/ignore", async (c) => {
    const { ignoreTx, renderTxUpdate } = await import("../../controllers/reconciliation.ts");
    const txId = c.req.param("txId");
    try {
      await ignoreTx(txId);
      return c.html(
        await renderTxUpdate(txId, { type: "success", message: "Movimento ignorado." }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro";
      return c.html(await renderTxUpdate(txId, { type: "error", message: msg }));
    }
  });
  panelRouter.post("/admin/c/:cid/reconciliation/tx/:txId/unignore", async (c) => {
    const { unignoreTx, renderTxUpdate } = await import("../../controllers/reconciliation.ts");
    const txId = c.req.param("txId");
    try {
      await unignoreTx(txId);
      return c.html(
        await renderTxUpdate(txId, { type: "success", message: "Movimento retomado." }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro";
      return c.html(await renderTxUpdate(txId, { type: "error", message: msg }));
    }
  });

  // Reverter conciliação - modal hx-get + ação hx-post.
  panelRouter.get("/admin/c/:cid/reconciliation/tx/:txId/reverse-modal", async (c) => {
    const { renderReverseModal } = await import("../../controllers/reconciliation.ts");
    return c.html(await renderReverseModal(c.req.param("txId")));
  });

  panelRouter.post("/admin/c/:cid/reconciliation/tx/:txId/reverse", async (c) => {
    const { reverseTx, renderTxUpdate } = await import("../../controllers/reconciliation.ts");
    const txId = c.req.param("txId");
    const body = await c.req.parseBody();
    const reason = parseFormString(body as Record<string, string | File>, "reason");
    try {
      const { voidedReceipts } = await reverseTx(txId, reason);
      // O recibo anulado em cascata é invisível nesta página - dizê-lo aqui
      // evita a dúvida de "e o recibo, ficou por cancelar?".
      const message = voidedReceipts === 0
        ? "Movimento revertido."
        : voidedReceipts === 1
        ? "Movimento revertido. 1 recibo anulado."
        : `Movimento revertido. ${voidedReceipts} recibos anulados.`;
      return c.html(await renderTxUpdate(txId, { type: "success", message }));
    } catch (err) {
      const { extractApiErrorMessage } = await import("../_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro a reverter");
      return c.html(await renderTxUpdate(txId, { type: "error", message: msg }));
    }
  });
}
