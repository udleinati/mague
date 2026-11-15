// Routes /admin/c/:cid/billing-reminders/* - Lembretes de cobrança (ADR 0028)
// + filtros bloco/plano (ADR 0039). Página listagem + POST send (individual ou
// bulk). Os filtros viajam por query string para o fragmento HTMX preservar a
// vista após cada envio.

import type { Context, Hono } from "hono";
import { parseFlashFromQuery } from "../_flash.ts";
import { type FlashType, htmxAction, htmxOrRedirect } from "../_htmx_response.ts";
import { render } from "$panel/render.ts";
import { client } from "$panel/client.ts";
import {
  type BillingFilters,
  normalizeBillingFilters,
} from "../../controllers/admin_billing_reminder.ts";

function filtersFromQuery(c: Context): BillingFilters {
  return normalizeBillingFilters({ overdue: c.req.query("overdue"), plan: c.req.query("plan") });
}

export function registerBillingRemindersRoutes(panelRouter: Hono): void {
  // HTMX-aware: HX-Request retorna a página (htmx extrai #billing-reminders);
  // sem header, redirect com flash query string. `filters` mantém a vista.
  const respondBilling = async (
    c: Context,
    filters: BillingFilters,
    message: string,
    flashType: FlashType = "success",
  ): Promise<Response> => {
    return await htmxOrRedirect(c, {
      message,
      flashType,
      redirectPath: "billing-reminders",
      renderFragment: async (flash) => {
        const { listPage } = await import("../../controllers/admin_billing_reminder.ts");
        return await listPage(filters, flash);
      },
    });
  };

  panelRouter.get("/admin/c/:cid/billing-reminders", async (c) => {
    const { listPage } = await import("../../controllers/admin_billing_reminder.ts");
    return c.html(await listPage(filtersFromQuery(c), parseFlashFromQuery(c) ?? undefined));
  });

  // Grava a nota da administração (persistente no condomínio). HTMX: só toast
  // (hx-swap="none" no form; o OOB do toast aplica-se na mesma). Não toca na
  // lista de frações, por isso fica fora do swap de #billing-reminders.
  panelRouter.post("/admin/c/:cid/billing-reminders/note", async (c) => {
    return await htmxAction(c, {
      action: async (form) => {
        const { saveNote } = await import("../../controllers/admin_billing_reminder.ts");
        const raw = String(form.note ?? "").trim();
        return await saveNote(raw === "" ? null : raw);
      },
      renderSuccess: () =>
        render("pages/reconciliation/_toast.vto", {
          toast: { type: "success", message: "Nota da administração guardada." },
        }),
      redirectPath: "billing-reminders",
      successMsg: "Nota da administração guardada.",
      errorPrefix: "Erro a guardar a nota",
    });
  });

  // Pré-visualização do email de uma fração (modal). GET read-only: o mesmo assunto
  // e HTML do envio (com a nota gravada), em JSON, sem enviar nem registar.
  panelRouter.get("/admin/c/:cid/billing-reminders/units/:uid/preview", async (c) => {
    const uid = c.req.param("uid");
    try {
      const res = await client.admin.previewBillingReminder(uid);
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

  panelRouter.post("/admin/c/:cid/billing-reminders/units/:uid/send", async (c) => {
    const uid = c.req.param("uid");
    const filters = filtersFromQuery(c);
    const body = await c.req.parseBody().catch(() => ({}));
    const trigger = (body as { trigger?: string }).trigger === "bulk" ? "bulk" : "individual";
    try {
      const { sendOne } = await import("../../controllers/admin_billing_reminder.ts");
      const result = await sendOne(uid, trigger);
      const msg = result.sentCount === 0
        ? "Nenhum email enviado (verifica logs)."
        : result.sentCount === 1
        ? "1 email enviado."
        : `${result.sentCount} emails enviados.`;
      return await respondBilling(
        c,
        filters,
        msg,
        result.sentCount === 0 ? "warning" : "success",
      );
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)) ||
        "Erro a enviar lembrete.";
      return await respondBilling(c, filters, msg, "danger");
    }
  });

  // Bulk: itera as unidades elegíveis (não em cooldown E sem plano de pagamento
  // ativo - ADR 0039: não cobra quem tem acordo). Respeita o filtro corrente.
  // Sequencial para evitar rate-limit do SMTP e race conditions na BD.
  panelRouter.post("/admin/c/:cid/billing-reminders/send-all", async (c) => {
    const filters = filtersFromQuery(c);
    try {
      const overdueRes = await client.admin.listBillingOverdueUnits(filters);
      const elig = overdueRes.data.units.filter((u) => !u.inCooldown && !u.hasActivePlan);
      let sent = 0;
      let failed = 0;
      for (const u of elig) {
        try {
          const r = await client.admin.sendBillingReminder(u.unitId, { trigger: "bulk" });
          sent += r.data.sentCount;
        } catch {
          failed += 1;
        }
      }
      const msg = `Enviados ${sent} email(s) em ${elig.length} fração(ões).${
        failed > 0 ? ` ${failed} falharam.` : ""
      }`;
      return await respondBilling(c, filters, msg, failed > 0 ? "warning" : "success");
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)) ||
        "Erro a enviar lembretes.";
      return await respondBilling(c, filters, msg, "danger");
    }
  });
}
