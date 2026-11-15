// Routes /admin/c/:cid/budget/* - orçamentos, linhas, geração de quotas.

import type { Hono } from "hono";
import { condoUrl } from "../../urls.ts";
import { runFormAction } from "../_form_action.ts";
import { getBudget, listBudgets } from "../../controllers/budget.ts";

export function registerBudgetRoutes(panelRouter: Hono): void {
  panelRouter.get("/admin/c/:cid/budget", async (c) => {
    const showNotApproved = c.req.query("nao-aprovados") === "1";
    return c.html(await listBudgets(showNotApproved));
  });

  panelRouter.post("/admin/c/:cid/budget", (c) =>
    runFormAction(c, async (form) => {
      const { createBudget } = await import("../../controllers/budget.ts");
      return await createBudget(form);
    }, {
      successPath: (r) => `budget/${r.created.id}`,
      successMsg: "Orçamento criado.",
      errorPath: "budget",
      errorPrefix: "Erro ao criar orçamento",
    }));

  panelRouter.get("/admin/c/:cid/budget/:id", async (c) => {
    const id = c.req.param("id");
    const html = await getBudget(id);
    return c.html(html);
  });

  panelRouter.post("/admin/c/:cid/budget/:id/edit", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const { editBudget } = await import("../../controllers/budget.ts");
      return await editBudget(id, form);
    }, {
      successPath: `budget/${id}`,
      successMsg: "Descrição atualizada.",
      errorPrefix: "Erro ao atualizar descrição",
    });
  });

  // PDF do orçamento (proxy ao endpoint /pdf da API). Abre em nova aba.
  panelRouter.get("/admin/c/:cid/budget/:id/pdf", async (c) => {
    const { downloadBudgetPdf } = await import("../../controllers/budget.ts");
    return await downloadBudgetPdf(c.req.param("id"));
  });

  // Marcação manual de proposta preterida (draft <-> not_approved). A aprovação
  // continua exclusiva da assembleia (ver itemType='approve_budget').
  panelRouter.post("/admin/c/:cid/budget/:id/reject", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async () => {
      const { rejectBudget } = await import("../../controllers/budget.ts");
      await rejectBudget(id);
    }, {
      successPath: "budget",
      successMsg: "Orçamento marcado como não aprovado.",
      errorPrefix: "Erro ao marcar orçamento",
    });
  });

  panelRouter.post("/admin/c/:cid/budget/:id/reopen", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async () => {
      const { reopenBudget } = await import("../../controllers/budget.ts");
      await reopenBudget(id);
    }, {
      successPath: "budget",
      successMsg: "Orçamento reaberto (voltou a rascunho).",
      errorPrefix: "Erro ao reabrir orçamento",
    });
  });

  panelRouter.post("/admin/c/:cid/budget/:id/delete", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async () => {
      const { deleteBudget } = await import("../../controllers/budget.ts");
      await deleteBudget(id);
    }, {
      successPath: "budget",
      successMsg: "Orçamento eliminado.",
      errorPrefix: "Erro ao eliminar orçamento",
    });
  });

  panelRouter.post("/admin/c/:cid/budget/:id/lines", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    await import("../../controllers/budget.ts").then((m) =>
      m.addBudgetLine(id, body as Record<string, string | File>)
    );
    return c.redirect(condoUrl(`budget/${id}`));
  });

  panelRouter.post("/admin/c/:cid/budget/:id/lines/:lineId", async (c) => {
    const id = c.req.param("id");
    const lineId = c.req.param("lineId");
    const body = await c.req.parseBody();
    await import("../../controllers/budget.ts").then((m) =>
      m.updateBudgetLine(id, lineId, body as Record<string, string | File>)
    );
    return c.redirect(condoUrl(`budget/${id}`));
  });

  panelRouter.post("/admin/c/:cid/budget/:id/lines/:lineId/delete", async (c) => {
    const id = c.req.param("id");
    const lineId = c.req.param("lineId");
    await import("../../controllers/budget.ts").then((m) => m.deleteBudgetLine(id, lineId));
    return c.redirect(condoUrl(`budget/${id}`));
  });

  // Gerar quotas a partir do budget (handler TS runQuotaGeneration).
  // Body: throughDate (YYYY-MM-DD). Idempotente - re-chamar só gera meses em falta.
  panelRouter.post("/admin/c/:cid/budget/:id/generate-quotas", async (c) => {
    const { generateQuotas } = await import("../../controllers/charges.ts");
    const id = c.req.param("id");
    const form = await c.req.parseBody();
    const { chargesCreated, crossesYear } = await generateQuotas(
      id,
      form as Record<string, string | File>,
    );
    let msg = chargesCreated > 0
      ? `${chargesCreated} quota(s) geradas.`
      : "Sem quotas novas a gerar para esta data.";
    const flashType = crossesYear ? "warning" : "success";
    if (crossesYear) msg += " Atenção: as prestações abrangem 2 anos fiscais.";
    return c.redirect(
      condoUrl(`budget/${id}?flash=${encodeURIComponent(msg)}&flashType=${flashType}`),
    );
  });
}
