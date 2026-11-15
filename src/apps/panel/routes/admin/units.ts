// Routes /admin/c/:cid/units/* - frações (CRUD + import + occupants link
// + impersonate). Inclui também `units/:id/charges` e `units/:id/credits`
// para criação rápida diretamente da página da fração.

import type { Hono } from "hono";
import { condoUrl } from "../../urls.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { runFormAction } from "../_form_action.ts";
import { parseFlashFromQuery } from "../_flash.ts";
import {
  addOccupantToUnit,
  deleteUnit,
  getUnit,
  listUnits,
  removeOccupantFromUnit,
  showUnit,
  updateUnit,
} from "../../controllers/units.ts";

export function registerUnitsRoutes(panelRouter: Hono): void {
  panelRouter.get("/admin/c/:cid/units", async (c) => {
    return c.html(await listUnits(undefined, parseFlashFromQuery(c)));
  });

  panelRouter.post("/admin/c/:cid/units/new", (c) =>
    runFormAction(c, async (form) => {
      const { createUnitManually } = await import("../../controllers/units.ts");
      return await createUnitManually(form);
    }, {
      successPath: (r) => `units/${r.created.id}`,
      successMsg: "Fração criada.",
      errorPath: "units",
      errorPrefix: "Erro ao criar fração",
    }));

  // Download do template xlsx - proxy à API com os headers de sessão.
  panelRouter.get("/admin/c/:cid/units/import/template.xlsx", async (_c) => {
    const { proxyDownload } = await import("../../libs/download_proxy.ts");
    const { client } = await import("../../client.ts");
    const upstream = await client.admin.downloadStream("/units/import/template.xlsx");
    return proxyDownload(upstream, {
      fallbackDisposition: 'attachment; filename="template.xlsx"',
    });
  });

  panelRouter.post("/admin/c/:cid/units/import/preview", async (c) => {
    const { previewImport } = await import("../../controllers/units.ts");
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File) || file.size === 0) {
      return c.redirect(
        condoUrl(`units?flash=${encodeURIComponent("Escolhe um ficheiro XLSX.")}&flashType=danger`),
      );
    }
    try {
      return c.html(await previewImport(file));
    } catch (err) {
      const { extractApiErrorMessage } = await import("../_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro ao pré-visualizar import.");
      return c.redirect(condoUrl(`units?flash=${encodeURIComponent(msg)}&flashType=danger`));
    }
  });

  panelRouter.post("/admin/c/:cid/units/import/commit", (c) =>
    runFormAction(c, async (form) => {
      const { commitImport } = await import("../../controllers/units.ts");
      return await commitImport(form);
    }, {
      successPath: "units",
      successMsg: (r) =>
        `Importado: ${r.unitsCreated} fração(ões), ${r.occupantsCreated} ocupante(s), ${r.linksCreated} vínculo(s).`,
      errorPrefix: "Erro ao importar",
    }));

  panelRouter.get("/admin/c/:cid/units/:id", async (c) => {
    return c.html(await showUnit(c.req.param("id"), parseFlashFromQuery(c)));
  });

  panelRouter.post("/admin/c/:cid/units/:id/charges", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const { addChargeToUnit } = await import("../../controllers/units.ts");
      await addChargeToUnit(id, form);
    }, {
      successPath: `units/${id}`,
      successMsg: "Cobrança adicionada.",
      errorPrefix: "Erro ao adicionar cobrança",
    });
  });

  panelRouter.post("/admin/c/:cid/units/:id/credits", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const { addCreditToUnit } = await import("../../controllers/units.ts");
      await addCreditToUnit(id, form);
    }, {
      successPath: `units/${id}`,
      successMsg: "Crédito adicionado.",
      errorPrefix: "Erro ao adicionar crédito",
    });
  });

  panelRouter.get("/admin/c/:cid/units/:id/edit", async (c) => {
    const id = c.req.param("id");
    const html = await getUnit(id);
    return c.html(html);
  });

  panelRouter.post("/admin/c/:cid/units/:id/update", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      return await updateUnit(id, form);
    }, {
      // Fica na edição (preserva contexto/scroll), não volta à listagem.
      successPath: `units/${id}/edit`,
      successMsg: "Fração atualizada.",
      errorPath: `units/${id}/edit`,
      errorPrefix: "Erro ao atualizar fração",
    });
  });

  panelRouter.post("/admin/c/:cid/units/:id/delete", (c) =>
    runFormAction(c, async () => {
      return await deleteUnit(c.req.param("id"));
    }, {
      successPath: "units",
      successMsg: "Fração eliminada.",
      errorPrefix: "Erro ao eliminar fração",
    }));

  // Atualizar palavras-chave para pre-seleção automática na conciliação.
  panelRouter.post("/admin/c/:cid/units/:id/match-keywords", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const { updateUnitMatchKeywords } = await import("../../controllers/units.ts");
      await updateUnitMatchKeywords(id, form);
    }, {
      successPath: `units/${id}/edit`,
      successMsg: "Palavras-chave atualizadas.",
      errorPrefix: "Erro ao guardar palavras-chave",
    });
  });

  panelRouter.post("/admin/c/:cid/units/:id/occupants", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const occupantId = parseFormString(form, "occupantId");
      const relationshipType = parseFormString(form, "relationshipType", { default: "owner" });
      if (occupantId) await addOccupantToUnit(id, occupantId, relationshipType);
    }, {
      successPath: `units/${id}/edit`,
      successMsg: "Condómino associado.",
      errorPrefix: "Erro ao associar condómino",
    });
  });

  panelRouter.post("/admin/c/:cid/units/:id/occupants/:occupantId/remove", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async () => {
      await removeOccupantFromUnit(id, c.req.param("occupantId"));
    }, {
      successPath: `units/${id}/edit`,
      successMsg: "Associação removida.",
      errorPrefix: "Erro ao remover associação",
    });
  });

  // ── Plano de pagamento (ADR 0039) ──────────────────────────────────────────
  panelRouter.post("/admin/c/:cid/units/:id/payment-plans", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const { createUnitPaymentPlan } = await import("../../controllers/units.ts");
      await createUnitPaymentPlan(id, form);
    }, {
      successPath: `units/${id}`,
      successMsg: "Plano de pagamento criado.",
      errorPrefix: "Erro ao criar plano de pagamento",
    });
  });

  panelRouter.post("/admin/c/:cid/units/:id/payment-plans/:planId/edit", (c) => {
    const id = c.req.param("id");
    const planId = c.req.param("planId");
    return runFormAction(c, async (form) => {
      const { updateUnitPaymentPlan } = await import("../../controllers/units.ts");
      await updateUnitPaymentPlan(id, planId, form);
    }, {
      successPath: `units/${id}`,
      successMsg: "Plano de pagamento atualizado.",
      errorPrefix: "Erro ao atualizar plano de pagamento",
    });
  });

  panelRouter.post("/admin/c/:cid/units/:id/payment-plans/:planId/transition", (c) => {
    const id = c.req.param("id");
    const planId = c.req.param("planId");
    return runFormAction(c, async (form) => {
      const { transitionUnitPaymentPlan } = await import("../../controllers/units.ts");
      await transitionUnitPaymentPlan(id, planId, parseFormString(form, "status"));
    }, {
      successPath: `units/${id}`,
      successMsg: "Plano de pagamento atualizado.",
      errorPrefix: "Erro ao atualizar plano de pagamento",
    });
  });

  // ── Impersonate (admin → portal do condómino) ─────────────────────────────
  // Path-based: `cid + uid` no URL são a fonte única de verdade da fração.
  panelRouter.post("/admin/c/:cid/units/:id/impersonate", (c) => {
    const cid = c.req.param("cid");
    const unitId = c.req.param("id");
    return c.redirect(`/portal/c/${cid}/u/${unitId}`);
  });
}
