// Routes /admin/c/:cid/insurances/* - apólices: aprovar/rejeitar + reminders.
// Filtros (year, status) preservados pelo `runFormAction` quando o successPath
// é uma listagem; ver `routes/_form_action.ts`.

import type { Hono } from "hono";
import { condoUrl } from "../../urls.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { runFormAction } from "../_form_action.ts";
import { htmxAction } from "../_htmx_response.ts";
import { refererQueryAppend } from "../_referer.ts";
import { client } from "$panel/client.ts";

export function registerInsurancesRoutes(panelRouter: Hono): void {
  panelRouter.get("/admin/c/:cid/insurances", async (c) => {
    const { listPage } = await import("../../controllers/admin_insurance.ts");
    const url = new URL(c.req.url);
    // Distingue "param ausente" de "param vazio" (=`Todos` explícito). Hoje os
    // dois dão `Todos`; a distinção fica porque é o contrato do tri-state.
    const year = url.searchParams.has("year") ? url.searchParams.get("year") : undefined;
    const status = url.searchParams.get("status");
    return c.html(await listPage({ year, status }));
  });

  panelRouter.get(
    "/admin/c/:cid/insurances/:policyId/attachments/:attachmentId",
    async (c) => {
      const { serveAttachment } = await import("../../controllers/admin_insurance.ts");
      return await serveAttachment(c.req.param("policyId"), c.req.param("attachmentId"));
    },
  );

  panelRouter.get("/admin/c/:cid/insurances/:policyId/pdf", async (c) => {
    const { downloadPdf } = await import("../../controllers/admin_insurance.ts");
    return await downloadPdf(c.req.param("policyId"));
  });

  // unitId da policy, necessário antes do delete (a policy desaparece) p/ refresh OOB.
  async function lookupUnitId(policyId: string): Promise<string | null> {
    try {
      const { data } = await client.admin.getInsurancePolicy(policyId);
      return String((data as { unitId?: string }).unitId ?? "") || null;
    } catch {
      return null;
    }
  }

  panelRouter.post("/admin/c/:cid/insurances/:policyId/approve", async (c) => {
    const policyId = c.req.param("policyId");
    const { approvePolicy, renderUnitRowsHtmx } = await import(
      "../../controllers/admin_insurance.ts"
    );
    const unitId = await lookupUnitId(policyId);
    return htmxAction(c, {
      action: () => approvePolicy(policyId),
      renderSuccess: async () =>
        unitId ? await renderUnitRowsHtmx(unitId, "Apólice aprovada.") : "<div></div>",
      redirectPath: "insurances",
      successMsg: "Apólice aprovada.",
      errorPrefix: "Erro a aprovar",
    });
  });

  // ─── PATCH consolidado: edit dos 6 campos via modal (ADR 0019) ─────────────
  // Substitui os antigos /auto-renew + /coverage-amount. Gate `pending_review`
  // é enforced no API handler (ADR 0016).
  panelRouter.post(
    "/admin/c/:cid/insurances/:policyId/update",
    async (c) => {
      const policyId = c.req.param("policyId");
      const { editPolicy, renderUnitRowsHtmx } = await import(
        "../../controllers/admin_insurance.ts"
      );
      const unitId = await lookupUnitId(policyId);
      return htmxAction(c, {
        action: (form) => editPolicy(policyId, form),
        renderSuccess: async () => {
          // HX-Trigger `policySaved` é apanhado pelo JS do modal para
          // fechar a dialog após o swap das rows.
          c.header("HX-Trigger", "policySaved");
          return unitId ? await renderUnitRowsHtmx(unitId, "Apólice atualizada.") : "<div></div>";
        },
        redirectPath: "insurances",
        successMsg: "Apólice atualizada.",
        errorPrefix: "Erro a atualizar apólice",
      });
    },
  );

  panelRouter.post("/admin/c/:cid/insurances/:policyId/reopen", async (c) => {
    const policyId = c.req.param("policyId");
    const { reopenPolicy, renderUnitRowsHtmx } = await import(
      "../../controllers/admin_insurance.ts"
    );
    const unitId = await lookupUnitId(policyId);
    return htmxAction(c, {
      action: () => reopenPolicy(policyId),
      renderSuccess: async () =>
        unitId
          ? await renderUnitRowsHtmx(unitId, "Apólice reaberta (pending_review).")
          : "<div></div>",
      redirectPath: "insurances",
      successMsg: "Apólice reaberta.",
      errorPrefix: "Erro a reabrir apólice",
    });
  });

  // Renovar aceita os dois caminhos no mesmo endpoint: multipart com o documento
  // entregue à administração (fica a aguardar aprovação, a antiga continua
  // ativa) ou sem ficheiro nenhum (renovação presumida de sempre).
  const renewedMsg = (r: { documented: boolean }) =>
    r.documented
      ? "Renovação registada com o documento - falta aprovar."
      : "Apólice renovada (presumida, sem evidência ainda).";

  panelRouter.post("/admin/c/:cid/insurances/:policyId/renew", async (c) => {
    const policyId = c.req.param("policyId");
    const { renewPolicy, renderUnitRowsHtmx } = await import(
      "../../controllers/admin_insurance.ts"
    );
    const unitId = await lookupUnitId(policyId);
    return htmxAction(c, {
      action: (form) => renewPolicy(policyId, form),
      renderSuccess: async (r) => {
        c.header("HX-Trigger", "policySaved");
        return unitId ? await renderUnitRowsHtmx(unitId, renewedMsg(r)) : "<div></div>";
      },
      redirectPath: "insurances",
      successMsg: renewedMsg,
      errorPrefix: "Erro a renovar apólice",
    });
  });

  // Registar de raiz o documento entregue à administração (fração sem apólice).
  // `units/` é literal, não colide com `/insurances/:policyId/<ação>`.
  panelRouter.post("/admin/c/:cid/insurances/units/:unitId", async (c) => {
    const unitId = c.req.param("unitId");
    const { createPolicy, renderUnitRowsHtmx } = await import(
      "../../controllers/admin_insurance.ts"
    );
    return htmxAction(c, {
      action: (form) => createPolicy(unitId, form),
      renderSuccess: async () => {
        c.header("HX-Trigger", "policySaved");
        return await renderUnitRowsHtmx(unitId, "Apólice registada - falta aprovar.");
      },
      redirectPath: "insurances",
      successMsg: "Apólice registada - falta aprovar.",
      errorPrefix: "Erro a registar apólice",
    });
  });

  // Desfaz a renovação: a presumida desaparece, logo o unitId vai antes (igual
  // ao delete). A linha que fica é a do predecessor restaurado, na mesma fração.
  panelRouter.post("/admin/c/:cid/insurances/:policyId/undo-renewal", async (c) => {
    const policyId = c.req.param("policyId");
    const { undoRenewal, renderUnitRowsHtmx } = await import(
      "../../controllers/admin_insurance.ts"
    );
    const unitId = await lookupUnitId(policyId);
    return htmxAction(c, {
      action: () => undoRenewal(policyId),
      renderSuccess: async () =>
        unitId
          ? await renderUnitRowsHtmx(unitId, "Renovação desfeita - apólice anterior reativada.")
          : "<div></div>",
      redirectPath: "insurances",
      successMsg: "Renovação desfeita - apólice anterior reativada.",
      errorPrefix: "Erro a desfazer a renovação",
    });
  });

  panelRouter.post("/admin/c/:cid/insurances/:policyId/delete", async (c) => {
    const policyId = c.req.param("policyId");
    const { deletePolicy, renderUnitRowsAfterDeleteHtmx } = await import(
      "../../controllers/admin_insurance.ts"
    );
    // Fetch unitId ANTES do delete (depois a policy desaparece).
    const unitId = await lookupUnitId(policyId);
    return htmxAction(c, {
      action: () => deletePolicy(policyId),
      renderSuccess: async () =>
        unitId ? await renderUnitRowsAfterDeleteHtmx(unitId, "Apólice apagada.") : "<div></div>",
      redirectPath: "insurances",
      successMsg: "Apólice apagada.",
      errorPrefix: "Erro a apagar apólice",
    });
  });

  panelRouter.post("/admin/c/:cid/insurances/:policyId/reject", async (c) => {
    const { rejectPolicy } = await import("../../controllers/admin_insurance.ts");
    const policyId = c.req.param("policyId");
    const isHtmx = c.req.header("HX-Request") === "true";
    const body = await c.req.parseBody() as Record<string, string | File>;
    const reason = parseFormString(body, "reason");

    if (isHtmx) {
      const { renderUnitRowsHtmx } = await import(
        "../../controllers/admin_insurance.ts"
      );
      const { render } = await import("../../render.ts");
      if (!reason) {
        return c.html(
          await render("pages/reconciliation/_toast.vto", {
            toast: { type: "error", message: "Razão é obrigatória." },
          }),
        );
      }
      const unitId = await lookupUnitId(policyId);
      try {
        await rejectPolicy(policyId, { reason });
        if (!unitId) return c.html(`<div></div>`);
        return c.html(await renderUnitRowsHtmx(unitId, "Apólice rejeitada."));
      } catch (err) {
        const { extractApiErrorMessage } = await import("../_form_error.ts");
        const msg = extractApiErrorMessage(err, "Erro a rejeitar");
        return c.html(
          await render("pages/reconciliation/_toast.vto", {
            toast: { type: "error", message: msg },
          }),
        );
      }
    }

    // Fallback legacy (no-JS): redirect com flash.
    const back = `insurances${refererQueryAppend(c)}`;
    const sep = back.includes("?") ? "&" : "?";
    if (!reason) {
      return c.redirect(
        condoUrl(
          `${back}${sep}flash=${encodeURIComponent("Razão é obrigatória.")}&flashType=danger`,
        ),
      );
    }
    await rejectPolicy(policyId, { reason });
    return c.redirect(
      condoUrl(
        `${back}${sep}flash=${encodeURIComponent("Apólice rejeitada.")}&flashType=success`,
      ),
    );
  });

  // Grava a nota da administração (persistente no condomínio). HTMX: só toast
  // (hx-swap="none" no form). Espelha o billing-reminders/note.
  panelRouter.post("/admin/c/:cid/insurances/note", async (c) => {
    return await htmxAction(c, {
      action: async (form) => {
        const { saveNote } = await import("../../controllers/admin_insurance.ts");
        const raw = String(form.note ?? "").trim();
        return await saveNote(raw === "" ? null : raw);
      },
      renderSuccess: async () => {
        const { render } = await import("../../render.ts");
        return await render("pages/reconciliation/_toast.vto", {
          toast: { type: "success", message: "Nota da administração guardada." },
        });
      },
      redirectPath: "insurances",
      successMsg: "Nota da administração guardada.",
      errorPrefix: "Erro a guardar a nota",
    });
  });

  // Pré-visualização do email de uma fração (modal/iframe). GET read-only: o mesmo
  // assunto e HTML do envio (com a nota gravada), em JSON, sem enviar nem registar.
  panelRouter.get("/admin/c/:cid/insurances/reminders/:unitId/preview", async (c) => {
    const unitId = c.req.param("unitId");
    try {
      const res = await client.admin.previewInsuranceReminder(unitId);
      return c.json({ subject: res.data.subject, html: res.data.html });
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)) ||
        "Erro a gerar a pré-visualização.";
      const safe = msg.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      return c.json({
        subject: null,
        html:
          `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;padding:2rem;color:#b91c1c;max-width:40rem;margin:2rem auto;">${safe}</body>`,
      }, 422);
    }
  });

  panelRouter.post("/admin/c/:cid/insurances/reminders/:unitId", async (c) => {
    const unitId = c.req.param("unitId");
    // Modo HTMX: devolve só partial OOB + toast (sem redirect → filtros na URL
    // continuam intactos). Modo legacy (no-JS / fallback): redirect com flash.
    if (c.req.header("HX-Request") === "true") {
      const { sendReminderHtmx } = await import("../../controllers/admin_insurance.ts");
      const form = (await c.req.parseBody()) as Record<string, string | File>;
      return c.html(await sendReminderHtmx(unitId, form));
    }
    return runFormAction(c, async () => {
      const { sendReminder } = await import("../../controllers/admin_insurance.ts");
      return await sendReminder(unitId);
    }, {
      successPath: "insurances",
      successMsg: (r) =>
        `${r.sent} email(s) enviado(s)${r.failed > 0 ? `, ${r.failed} falharam` : ""}.`,
      errorPrefix: "Erro",
    });
  });

  panelRouter.post("/admin/c/:cid/insurances/reminders", (c) =>
    runFormAction(c, async () => {
      const { sendBulkReminders } = await import("../../controllers/admin_insurance.ts");
      return await sendBulkReminders();
    }, {
      successPath: "insurances",
      successMsg: (r) => {
        const skipped = (r.skippedNoEmail ?? []).length;
        let flash = `${r.sent} email(s) enviado(s) (${r.unitsTargeted} frações abrangidas)`;
        if ((r.evidenceTargeted ?? 0) > 0) {
          flash += `, ${r.evidenceTargeted} a pedir o comprovativo da renovação`;
        }
        if (r.failed > 0) flash += `, ${r.failed} falharam`;
        if (skipped > 0) {
          flash += ` · ${skipped} frações saltadas por falta de email: ${
            r.skippedNoEmail!.join(", ")
          }`;
        }
        return flash + ".";
      },
      successFlashType: (r) =>
        r.failed > 0 || (r.skippedNoEmail ?? []).length > 0 ? "warning" : "success",
      errorPrefix: "Erro",
    }));
}
