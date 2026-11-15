// Routes /admin/c/:cid/charges/* - quotas + despesas + attachments.

import type { Context, Hono } from "hono";
import { condoUrl } from "../../urls.ts";
import { runFormAction } from "../_form_action.ts";
import { parseFlashFromQuery } from "../_flash.ts";
import { type FlashType, htmxOrRedirect } from "../_htmx_response.ts";
import { formatMoney } from "$shared/format/mod.ts";

export function registerChargesRoutes(panelRouter: Hono): void {
  panelRouter.get("/admin/c/:cid/charges", async (c) => {
    const { listCharges, listChargesFragment } = await import("../../controllers/charges.ts");
    const params: Record<string, string> = {};
    for (const [k, v] of new URL(c.req.url).searchParams.entries()) params[k] = v;
    // HX-Request: só o fragmento (swap em #charges-fragment, sem reload).
    // Browser nav (cmd+click, refresh, share URL) entra pela página completa.
    if (c.req.header("HX-Request") === "true") {
      return c.html(await listChargesFragment(params));
    }
    return c.html(await listCharges(params, parseFlashFromQuery(c)));
  });
  panelRouter.post("/admin/c/:cid/charges", (c) =>
    runFormAction(c, async (form) => {
      const { createCharge } = await import("../../controllers/charges.ts");
      return await createCharge(form);
    }, {
      successPath: (r) => `charges/${r.id}`,
      successMsg: "Cobrança criada.",
      errorPath: (form) => `charges?kind=${String(form.kind ?? "payable")}`,
      errorPrefix: "Erro ao criar cobrança",
    }));
  panelRouter.get("/admin/c/:cid/charges/:id", async (c) => {
    const { showCharge } = await import("../../controllers/charges.ts");
    return c.html(await showCharge(c.req.param("id"), parseFlashFromQuery(c)));
  });
  panelRouter.post("/admin/c/:cid/charges/:id/update", async (c) => {
    const { updateCharge } = await import("../../controllers/charges.ts");
    const id = c.req.param("id");
    const form = await c.req.parseBody();
    await updateCharge(id, form as Record<string, string | File>);
    // Redirect opcional: se veio `?redirect=<path>` no body, honra. Útil para o
    // atalho "ajustar e voltar à conciliação". Senão, fica na show da charge.
    const redirectTo = typeof form.redirectTo === "string" ? form.redirectTo : null;
    return c.redirect(
      redirectTo ||
        condoUrl(
          `charges/${id}?flash=${encodeURIComponent("Charge atualizada.")}&flashType=success`,
        ),
    );
  });
  panelRouter.post("/admin/c/:cid/charges/:id/cancel", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async () => {
      const { cancelCharge } = await import("../../controllers/charges.ts");
      return await cancelCharge(id);
    }, {
      successPath: `charges/${id}`,
      successMsg: "Cobrança cancelada.",
      errorPrefix: "Erro ao cancelar cobrança",
    });
  });
  panelRouter.post("/admin/c/:cid/charges/:id/budget", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const { setChargeBudget } = await import("../../controllers/charges.ts");
      return await setChargeBudget(id, form);
    }, {
      successPath: `charges/${id}`,
      successMsg: "Imputação ao orçamento atualizada.",
      errorPrefix: "Erro ao etiquetar a despesa",
    });
  });
  panelRouter.post("/admin/c/:cid/charges/:id/refacturations", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const { createRefacturations } = await import("../../controllers/charges.ts");
      return await createRefacturations(id, form);
    }, {
      successPath: `charges/${id}`,
      successMsg: (r) =>
        `Refaturado ${r.created} fração(ões), total ${formatMoney(r.total_cents)}.`,
      errorPrefix: "Erro ao refaturar",
    });
  });

  // ── Charge attachments (faturas, recibos, comprovativos) ────────────────────
  // HTMX-aware via helper canónico (`_htmx_response.ts`). Ver ADR 0026.
  const respondCharge = async (
    c: Context,
    id: string,
    message: string,
    flashType: FlashType = "success",
  ): Promise<Response> => {
    return await htmxOrRedirect(c, {
      message,
      flashType,
      redirectPath: `charges/${id}`,
      renderFragment: async (flash) => {
        const { showCharge } = await import("../../controllers/charges.ts");
        return await showCharge(id, flash);
      },
    });
  };

  // Upload multipart. Lê via `getAll("files")` (parseBody colapsava ao último);
  // 1 POST por ficheiro porque a API aceita 1 file/chamada.
  panelRouter.post("/admin/c/:cid/charges/:id/attachments", async (c) => {
    const id = c.req.param("id");
    try {
      const fd = await c.req.formData();
      const files = fd.getAll("files")
        .filter((v): v is File => v instanceof File && v.size > 0);
      if (files.length === 0) {
        return await respondCharge(c, id, "Seleciona pelo menos um ficheiro.", "danger");
      }
      const { uploadChargeAttachment } = await import("../../controllers/charges.ts");
      // Sequencial (não paralelo) - preserva ordem visível na listagem e
      // evita rate-limits/race conditions no S3 quando o user carrega muitos.
      for (const file of files) {
        await uploadChargeAttachment(id, file);
      }
      const msg = files.length === 1 ? "Anexo carregado." : `${files.length} anexos carregados.`;
      return await respondCharge(c, id, msg, "success");
    } catch (err) {
      const { extractApiErrorMessage } = await import("../_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro a carregar anexo.");
      return await respondCharge(c, id, msg, "danger");
    }
  });

  panelRouter.get("/admin/c/:cid/charges/:id/attachments/:attachmentId", async (c) => {
    const id = c.req.param("id");
    const attachmentId = c.req.param("attachmentId");
    const { downloadChargeAttachment } = await import("../../controllers/charges.ts");
    return await downloadChargeAttachment(id, attachmentId);
  });

  panelRouter.post("/admin/c/:cid/charges/:id/attachments/:attachmentId/delete", async (c) => {
    const id = c.req.param("id");
    const attachmentId = c.req.param("attachmentId");
    try {
      const { deleteChargeAttachment } = await import("../../controllers/charges.ts");
      await deleteChargeAttachment(id, attachmentId);
      return await respondCharge(c, id, "Anexo removido.", "success");
    } catch (err) {
      const { extractApiErrorMessage } = await import("../_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro a remover anexo.");
      return await respondCharge(c, id, msg, "danger");
    }
  });
}
