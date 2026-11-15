// Portal do condómino. Routes /portal/* + /portal/c/:cid/*. Auth garantida
// pelo middleware (que injecta `als.portalUnitId` a partir do `uid` no path
// `/portal/c/:cid/u/:uid`; super/manager impersonam acedendo a qualquer uid).

import type { Hono } from "hono";
import { als } from "../context.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { parseEurosToCents } from "$shared/money/parse_euros.ts";

export function registerPortalRoutes(panelRouter: Hono): void {
  panelRouter.post("/portal/exit", (c) => {
    // Volta à página da fração que estávamos a ver (admin/c/<cid>/units/<uid>),
    // extraindo cid+uid do referer do portal (`/portal/c/<cid>/u/<uid>/...`).
    const referer = c.req.header("referer") ?? "";
    const m = referer.match(/\/portal\/c\/([^/]+)\/u\/([^/]+)/);
    if (m) return c.redirect(`/admin/c/${m[1]}/units/${m[2]}`);
    return c.redirect("/choose-condominium");
  });

  // Path-based unit selection: /portal/c/:cid/u/:uid/... O cid+uid no path são
  // a fonte única de verdade. O middleware já extraiu `uid` para o ALS e
  // validou que pertence aos occupantUnits do user (anti-IDOR).

  // Aterragem sem /u/<uid> - escolhe a 1ª fração do user no `cid` atual e faz
  // redirect para o path completo. Super que impersona usa o botão de
  // impersonate (vai direto a /u/<uid>), por isso aqui bastam os occupantUnits.
  panelRouter.get("/portal/c/:cid", async (c) => {
    const store = als.getStore();
    const cid = c.req.param("cid");
    const units = store?.user?.occupantUnits ?? [];
    const inThisCondo = units.find((u) => u.condominiumId === cid);
    if (inThisCondo) return c.redirect(`/portal/c/${cid}/u/${inThisCondo.unitId}`);
    const { renderNotFoundNeutral } = await import("../controllers/errors.ts");
    return c.html(
      await renderNotFoundNeutral({
        heading: "Sem fração para mostrar",
        subtitle: "Não estás associado a nenhuma fração neste condomínio.",
        attemptedPath: c.req.path,
      }),
      404,
    );
  });

  panelRouter.get("/portal/c/:cid/u/:uid", async (c) => {
    const { portalDashboard } = await import("../controllers/portal.ts");
    return c.html(await portalDashboard());
  });

  // ── Aviso de privacidade ──────────────────────────────────────────────
  // Gate no 1.º acesso: middleware redirige aqui até o user aceitar; POST
  // /accept regista timestamp. Coluna BD mantém o nome `terms_acknowledged_at`.
  panelRouter.get("/portal/c/:cid/u/:uid/privacy-notice", async (c) => {
    const { portalPrivacyNotice } = await import("../controllers/portal.ts");
    return c.html(await portalPrivacyNotice());
  });
  panelRouter.post("/portal/c/:cid/u/:uid/privacy-notice/accept", async (c) => {
    const { acceptPrivacyNotice } = await import("../controllers/portal.ts");
    await acceptPrivacyNotice();
    const cid = c.req.param("cid");
    const uid = c.req.param("uid");
    return c.redirect(`/portal/c/${cid}/u/${uid}`);
  });

  // Consulta read-only da política. Linkada no footer do portal para
  // estar sempre acessível (Art. 12º RGPD). O gate inicial vive em /privacy-notice.
  panelRouter.get("/portal/c/:cid/u/:uid/privacy", async (c) => {
    const { portalPrivacy } = await import("../controllers/portal.ts");
    return c.html(await portalPrivacy());
  });

  panelRouter.get("/portal/c/:cid/u/:uid/charges", async (c) => {
    const { portalCharges } = await import("../controllers/portal.ts");
    const url = new URL(c.req.url);
    // Distingue param ausente (default=oldest open year) de param vazio
    // (=Todos). Ambos preservados.
    const year = url.searchParams.has("year") ? url.searchParams.get("year") : undefined;
    return c.html(await portalCharges({ year }));
  });

  panelRouter.get("/portal/c/:cid/u/:uid/statement", async (c) => {
    const { portalExtrato } = await import("../controllers/portal.ts");
    const year = c.req.query("year");
    return c.html(await portalExtrato({ year }));
  });

  panelRouter.get("/portal/c/:cid/u/:uid/assemblies", async (c) => {
    const { portalAssembleias } = await import("../controllers/portal.ts");
    const year = c.req.query("year");
    return c.html(await portalAssembleias({ year }));
  });

  // Detalhe da convocatória - mostra o último snapshot enviado.
  panelRouter.get("/portal/c/:cid/u/:uid/assemblies/:aid", async (c) => {
    const { portalAssemblyDetail } = await import("../controllers/portal.ts");
    return c.html(await portalAssemblyDetail(c.req.param("aid")));
  });

  panelRouter.get("/portal/c/:cid/u/:uid/budgets/:id", async (c) => {
    const { portalBudgetDetail } = await import("../controllers/portal.ts");
    const id = c.req.param("id");
    return c.html(await portalBudgetDetail(id));
  });

  // Recibos do condómino - read-only. Detalhe + download PDF.
  panelRouter.get("/portal/c/:cid/u/:uid/receipts/:id", async (c) => {
    const { portalReceiptDetail } = await import("../controllers/portal.ts");
    return c.html(await portalReceiptDetail(c.req.param("id")));
  });
  panelRouter.get("/portal/c/:cid/u/:uid/receipts/:id/pdf", async (c) => {
    const { portalReceiptPdf } = await import("../controllers/portal.ts");
    return await portalReceiptPdf(c.req.param("id"));
  });

  panelRouter.get("/portal/c/:cid/u/:uid/profile", async (c) => {
    const { portalPerfil } = await import("../controllers/portal.ts");
    return c.html(await portalPerfil());
  });

  panelRouter.get("/portal/c/:cid/u/:uid/profile/edit", async (c) => {
    const { portalPerfilEdit } = await import("../controllers/portal.ts");
    return c.html(await portalPerfilEdit());
  });

  panelRouter.post("/portal/c/:cid/u/:uid/profile/edit", async (c) => {
    const { saveEditPortalProfile } = await import("../controllers/portal.ts");
    const cid = c.req.param("cid");
    const uid = c.req.param("uid");
    const base = `/portal/c/${cid}/u/${uid}/profile`;
    try {
      const form = (await c.req.parseBody()) as Record<string, string | File>;
      await saveEditPortalProfile(form);
      return c.redirect(
        `${base}?flash=${encodeURIComponent("Perfil atualizado.")}&flashType=success`,
      );
    } catch (err) {
      const { extractApiErrorMessage } = await import("./_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro a atualizar perfil");
      return c.redirect(`${base}/edit?flash=${encodeURIComponent(msg)}&flashType=danger`);
    }
  });

  // Toggle inline da preferência de recibos por email - usado pelo switch
  // no profile.vto. Form submit standard com redirect+flash (sem JS extra).
  panelRouter.post("/portal/c/:cid/u/:uid/profile/toggle-receipts", async (c) => {
    const { toggleReceiveReceipts } = await import("../controllers/portal.ts");
    const cid = c.req.param("cid");
    const uid = c.req.param("uid");
    const base = `/portal/c/${cid}/u/${uid}/profile`;
    try {
      const form = (await c.req.parseBody()) as Record<string, string | File>;
      const enabled = await toggleReceiveReceipts(form);
      const msg = enabled
        ? "Vais passar a receber recibos por email."
        : "Deixaste de receber recibos por email.";
      return c.redirect(`${base}?flash=${encodeURIComponent(msg)}&flashType=success`);
    } catch (err) {
      const { extractApiErrorMessage } = await import("./_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro a atualizar preferência");
      return c.redirect(`${base}?flash=${encodeURIComponent(msg)}&flashType=danger`);
    }
  });

  // ── Documentos públicos do condomínio (read-only) ─────────────────────
  panelRouter.get("/portal/c/:cid/u/:uid/documents", async (c) => {
    const { portalDocuments } = await import("../controllers/portal.ts");
    const category = c.req.query("category");
    return c.html(await portalDocuments({ category }));
  });
  panelRouter.get("/portal/c/:cid/u/:uid/documents/:id/attachments/:attachmentId", async (c) => {
    const { portalDocumentAttachment } = await import("../controllers/portal.ts");
    return await portalDocumentAttachment(c.req.param("id"), c.req.param("attachmentId"));
  });

  // ── Patologias (read-only, scope condomínio) ────────────────────────
  panelRouter.get("/portal/c/:cid/u/:uid/pathologies", async (c) => {
    const { listPage } = await import("../controllers/portal_pathology.ts");
    const statusGroup = new URL(c.req.url).searchParams.get("statusGroup") ?? undefined;
    return c.html(await listPage({ statusGroup }));
  });
  panelRouter.get("/portal/c/:cid/u/:uid/pathologies/:id", async (c) => {
    const { showPage } = await import("../controllers/portal_pathology.ts");
    return c.html(await showPage(c.req.param("id")));
  });
  panelRouter.get(
    "/portal/c/:cid/u/:uid/pathologies/:id/attachments/:attachmentId",
    async (c) => {
      const { attachmentProxy } = await import("../controllers/portal_pathology.ts");
      return await attachmentProxy(c.req.param("id"), c.req.param("attachmentId"));
    },
  );

  // ── Ocorrências ─────────────────────────────────────────────────────
  panelRouter.get("/portal/c/:cid/u/:uid/tickets", async (c) => {
    const { listPage } = await import("../controllers/portal_tickets.ts");
    const status = new URL(c.req.url).searchParams.get("status") ?? undefined;
    return c.html(await listPage({ status }));
  });

  panelRouter.post("/portal/c/:cid/u/:uid/tickets", async (c) => {
    const { createTicket } = await import("../controllers/portal_tickets.ts");
    const cid = c.req.param("cid");
    const uid = c.req.param("uid");
    const base = `/portal/c/${cid}/u/${uid}/tickets`;
    try {
      const form = (await c.req.parseBody()) as Record<string, string | File>;
      const created = await createTicket(form);
      return c.redirect(
        `${base}/${created.id}?flash=${
          encodeURIComponent("Ocorrência registada.")
        }&flashType=success`,
      );
    } catch (e) {
      const { extractApiErrorMessage } = await import("./_form_error.ts");
      const msg = extractApiErrorMessage(e, "Erro ao registar.");
      return c.redirect(`${base}?flash=${encodeURIComponent(msg)}&flashType=danger`);
    }
  });

  panelRouter.get("/portal/c/:cid/u/:uid/tickets/:tid", async (c) => {
    const { showPage } = await import("../controllers/portal_tickets.ts");
    return c.html(await showPage(c.req.param("tid")));
  });

  panelRouter.post("/portal/c/:cid/u/:uid/tickets/:tid/update", async (c) => {
    const { updateTicket } = await import("../controllers/portal_tickets.ts");
    const cid = c.req.param("cid");
    const uid = c.req.param("uid");
    const tid = c.req.param("tid");
    const base = `/portal/c/${cid}/u/${uid}/tickets/${tid}`;
    try {
      const form = (await c.req.parseBody()) as Record<string, string | File>;
      await updateTicket(tid, form);
      return c.redirect(
        `${base}?flash=${encodeURIComponent("Ocorrência atualizada.")}&flashType=success`,
      );
    } catch (err) {
      const { extractApiErrorMessage } = await import("./_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro a atualizar ocorrência");
      return c.redirect(`${base}?flash=${encodeURIComponent(msg)}&flashType=danger`);
    }
  });

  panelRouter.post("/portal/c/:cid/u/:uid/tickets/:tid/comments", async (c) => {
    const { addComment } = await import("../controllers/portal_tickets.ts");
    const cid = c.req.param("cid");
    const uid = c.req.param("uid");
    const tid = c.req.param("tid");
    const base = `/portal/c/${cid}/u/${uid}/tickets/${tid}`;
    try {
      const form = (await c.req.parseBody()) as Record<string, string | File>;
      await addComment(tid, form);
      return c.redirect(
        `${base}?flash=${encodeURIComponent("Comentário enviado.")}&flashType=success`,
      );
    } catch (err) {
      const { extractApiErrorMessage } = await import("./_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro a enviar comentário");
      return c.redirect(`${base}?flash=${encodeURIComponent(msg)}&flashType=danger`);
    }
  });

  panelRouter.post("/portal/c/:cid/u/:uid/tickets/:tid/delete", async (c) => {
    const { deleteTicket } = await import("../controllers/portal_tickets.ts");
    const cid = c.req.param("cid");
    const uid = c.req.param("uid");
    const tid = c.req.param("tid");
    const listBase = `/portal/c/${cid}/u/${uid}/tickets`;
    try {
      await deleteTicket(tid);
      return c.redirect(
        `${listBase}?flash=${encodeURIComponent("Ocorrência apagada.")}&flashType=success`,
      );
    } catch (err) {
      const { extractApiErrorMessage } = await import("./_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro a apagar ocorrência");
      return c.redirect(
        `${listBase}/${tid}?flash=${encodeURIComponent(msg)}&flashType=danger`,
      );
    }
  });

  // Anexos: upload, serve (proxy à API), delete.
  panelRouter.post(
    "/portal/c/:cid/u/:uid/tickets/:tid/attachments",
    async (c) => {
      const { uploadAttachment } = await import("../controllers/portal_tickets.ts");
      const cid = c.req.param("cid");
      const uid = c.req.param("uid");
      const tid = c.req.param("tid");
      const base = `/portal/c/${cid}/u/${uid}/tickets/${tid}`;
      try {
        const form = await c.req.formData();
        const file = form.get("file");
        if (!(file instanceof File) || file.size === 0) {
          throw new Error("Ficheiro em falta.");
        }
        await uploadAttachment(tid, file);
        return c.redirect(
          `${base}?flash=${encodeURIComponent("Anexo carregado.")}&flashType=success`,
        );
      } catch (err) {
        const { extractApiErrorMessage } = await import("./_form_error.ts");
        const msg = extractApiErrorMessage(err, "Erro a carregar anexo");
        return c.redirect(`${base}?flash=${encodeURIComponent(msg)}&flashType=danger`);
      }
    },
  );

  panelRouter.get(
    "/portal/c/:cid/u/:uid/tickets/:tid/attachments/:aid",
    async (c) => {
      const { proxyDownload } = await import("../libs/download_proxy.ts");
      const { client } = await import("../client.ts");
      const uid = c.req.param("uid");
      const tid = c.req.param("tid");
      const aid = c.req.param("aid");
      const upstream = await client.portal.downloadStream(
        `/units/${uid}/tickets/${tid}/attachments/${aid}`,
      );
      return proxyDownload(upstream);
    },
  );

  panelRouter.post(
    "/portal/c/:cid/u/:uid/tickets/:tid/attachments/:aid/delete",
    async (c) => {
      const { deleteAttachment } = await import("../controllers/portal_tickets.ts");
      const cid = c.req.param("cid");
      const uid = c.req.param("uid");
      const tid = c.req.param("tid");
      const aid = c.req.param("aid");
      const base = `/portal/c/${cid}/u/${uid}/tickets/${tid}`;
      try {
        await deleteAttachment(tid, aid);
        return c.redirect(
          `${base}?flash=${encodeURIComponent("Anexo removido.")}&flashType=success`,
        );
      } catch (err) {
        const { extractApiErrorMessage } = await import("./_form_error.ts");
        const msg = extractApiErrorMessage(err, "Erro a remover anexo");
        return c.redirect(`${base}?flash=${encodeURIComponent(msg)}&flashType=danger`);
      }
    },
  );

  // Anexo de uma assembleia - proxy direto para a API portal. O middleware
  // `requirePortalAccessToCondo` no API valida que o user tem unit no condo.
  panelRouter.get("/portal/c/:cid/u/:uid/assemblies/:aid/attachments/:fid", async (c) => {
    const { proxyDownload } = await import("../libs/download_proxy.ts");
    const { client } = await import("../client.ts");
    const aid = c.req.param("aid");
    const fid = c.req.param("fid");
    const upstream = await client.portal.downloadStream(`/assemblies/${aid}/attachments/${fid}`);
    return proxyDownload(upstream);
  });

  // ── Seguros (admin) ──────────────────────────────────────────────────────
  panelRouter.get("/portal/c/:cid/u/:uid/insurances", async (c) => {
    const { listPage } = await import("../controllers/portal_insurance.ts");
    return c.html(await listPage());
  });

  panelRouter.get("/portal/c/:cid/u/:uid/insurances/upload", async (c) => {
    const { uploadPage } = await import("../controllers/portal_insurance.ts");
    return c.html(await uploadPage());
  });

  // Renovar a apólice que a fração já tem (ADR 0016).
  // `renew` é literal e não colide com `/insurances/:policyId`.
  panelRouter.get("/portal/c/:cid/u/:uid/insurances/:policyId/renew", async (c) => {
    const { renewPage } = await import("../controllers/portal_insurance.ts");
    return c.html(await renewPage(c.req.param("policyId")));
  });

  panelRouter.post("/portal/c/:cid/u/:uid/insurances/:policyId/renew", async (c) => {
    const { submitRenewal } = await import("../controllers/portal_insurance.ts");
    const policyId = c.req.param("policyId");
    const base = `/portal/c/${c.req.param("cid")}/u/${c.req.param("uid")}/insurances`;
    const form = await c.req.formData();
    const file = form.get("file");

    const redirectErr = (msg: string) =>
      c.redirect(
        `${base}/${policyId}/renew?flash=` + encodeURIComponent(msg) + "&flashType=danger",
      );
    if (!(file instanceof File) || file.size === 0) {
      return redirectErr("Anexa o recibo ou comprovativo da renovação.");
    }
    const str = (name: string) => String(form.get(name) ?? "").trim();
    if (!str("validFrom")) return redirectErr("Data de início obrigatória.");
    if (!str("validTo")) return redirectErr("Data de fim obrigatória.");

    try {
      await submitRenewal(policyId, file, {
        validFrom: str("validFrom"),
        validTo: str("validTo"),
        policyNumber: str("policyNumber"),
        insurer: str("insurer"),
        coverageAmountEuros: str("coverageAmountEuros"),
      });
    } catch (e) {
      const { extractApiErrorMessage } = await import("./_form_error.ts");
      return redirectErr(extractApiErrorMessage(e, "Erro"));
    }
    return c.redirect(
      `${base}?flash=` +
        encodeURIComponent("Renovação enviada para revisão da administração.") +
        "&flashType=success",
    );
  });

  panelRouter.post("/portal/c/:cid/u/:uid/insurances/upload", async (c) => {
    const { submitUpload } = await import("../controllers/portal_insurance.ts");
    const form = await c.req.formData();
    // Multi-file (MF-A): aceita 1 ou N ficheiros sob `file`.
    const files = form.getAll("file").filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      return c.redirect(
        `/portal/c/${c.req.param("cid")}/u/${c.req.param("uid")}/insurances/upload?flash=` +
          encodeURIComponent("Ficheiro em falta.") + "&flashType=danger",
      );
    }
    try {
      const r = await submitUpload(files);
      return c.redirect(
        `/portal/c/${c.req.param("cid")}/u/${c.req.param("uid")}/insurances/${r.policyId}/confirm`,
      );
    } catch (e) {
      const { extractApiErrorMessage } = await import("./_form_error.ts");
      const msg = extractApiErrorMessage(e, "Erro");
      return c.redirect(
        `/portal/c/${c.req.param("cid")}/u/${c.req.param("uid")}/insurances/upload?flash=` +
          encodeURIComponent(msg) + "&flashType=danger",
      );
    }
  });

  panelRouter.get("/portal/c/:cid/u/:uid/insurances/:policyId/confirm", async (c) => {
    const { confirmPage } = await import("../controllers/portal_insurance.ts");
    return c.html(await confirmPage(c.req.param("policyId")));
  });

  panelRouter.get("/portal/c/:cid/u/:uid/insurances/:policyId", async (c) => {
    const { viewPage } = await import("../controllers/portal_insurance.ts");
    return c.html(await viewPage(c.req.param("policyId")));
  });

  panelRouter.post("/portal/c/:cid/u/:uid/insurances/:policyId/confirm", async (c) => {
    const { submitConfirm } = await import("../controllers/portal_insurance.ts");
    const body = await c.req.parseBody({ all: true }) as Record<string, string | File>;
    // Validação alinhada com a API: validFrom, validTo, policyNumber, insurer
    // obrigatórios. Capital segurado opcional.
    const validFrom = parseFormString(body, "validFrom");
    const validTo = parseFormString(body, "validTo");
    const policyNumber = parseFormString(body, "policyNumber");
    const insurer = parseFormString(body, "insurer");

    const redirectErr = (msg: string) =>
      c.redirect(
        `/portal/c/${c.req.param("cid")}/u/${c.req.param("uid")}/insurances/${
          c.req.param("policyId")
        }/confirm?flash=` + encodeURIComponent(msg) + "&flashType=danger",
      );
    if (!validFrom) return redirectErr("Data de início obrigatória.");
    if (!validTo) return redirectErr("Data de fim obrigatória.");
    if (!policyNumber) return redirectErr("Número da apólice obrigatório.");
    if (!insurer) return redirectErr("Seguradora obrigatória.");

    await submitConfirm(c.req.param("policyId"), {
      validFrom,
      validTo,
      policyNumber,
      insurer,
      // parseEurosToCents devolve null para empty/NaN/negativo; converte para undefined.
      coverageAmountCents: parseEurosToCents(body.coverageAmountEuros) ?? undefined,
    });
    return c.redirect(
      `/portal/c/${c.req.param("cid")}/u/${c.req.param("uid")}/insurances?flash=` +
        encodeURIComponent("Apólice enviada para revisão da administração.") +
        "&flashType=success",
    );
  });

  // ── Multi-file: add/serve/delete attachments to a policy ───────────────
  panelRouter.post(
    "/portal/c/:cid/u/:uid/insurances/:policyId/attachments",
    async (c) => {
      const { addAttachment } = await import("../controllers/portal_insurance.ts");
      const form = await c.req.formData();
      const file = form.get("file");
      const cid = c.req.param("cid");
      const uid = c.req.param("uid");
      const pid = c.req.param("policyId");
      // `?return=detail`: upload do comprovativo (página de detalhe da presumida)
      // volta ao detalhe; o fluxo de confirmação (pending_review) volta ao /confirm.
      const back = c.req.query("return") === "detail"
        ? `/portal/c/${cid}/u/${uid}/insurances/${pid}`
        : `/portal/c/${cid}/u/${uid}/insurances/${pid}/confirm`;
      if (!(file instanceof File)) {
        return c.redirect(
          `${back}?flash=${encodeURIComponent("Ficheiro em falta.")}&flashType=danger`,
        );
      }
      try {
        await addAttachment(pid, file);
        return c.redirect(
          `${back}?flash=${encodeURIComponent("Ficheiro adicionado.")}&flashType=success`,
        );
      } catch (err) {
        const { extractApiErrorMessage } = await import("./_form_error.ts");
        const msg = extractApiErrorMessage(err, "Erro a adicionar ficheiro");
        return c.redirect(`${back}?flash=${encodeURIComponent(msg)}&flashType=danger`);
      }
    },
  );

  panelRouter.get(
    "/portal/c/:cid/u/:uid/insurances/:policyId/attachments/:attachmentId",
    async (c) => {
      const { serveAttachment } = await import("../controllers/portal_insurance.ts");
      return await serveAttachment(c.req.param("policyId"), c.req.param("attachmentId"));
    },
  );

  panelRouter.post(
    "/portal/c/:cid/u/:uid/insurances/:policyId/attachments/:attachmentId/delete",
    async (c) => {
      const { deleteAttachment } = await import("../controllers/portal_insurance.ts");
      const cid = c.req.param("cid");
      const uid = c.req.param("uid");
      const pid = c.req.param("policyId");
      const back = `/portal/c/${cid}/u/${uid}/insurances/${pid}/confirm`;
      try {
        await deleteAttachment(pid, c.req.param("attachmentId"));
        return c.redirect(
          `${back}?flash=${encodeURIComponent("Ficheiro apagado.")}&flashType=success`,
        );
      } catch (err) {
        const { extractApiErrorMessage } = await import("./_form_error.ts");
        const msg = extractApiErrorMessage(err, "Erro a apagar ficheiro");
        return c.redirect(`${back}?flash=${encodeURIComponent(msg)}&flashType=danger`);
      }
    },
  );

  panelRouter.get("/portal/c/:cid/u/:uid/insurances/:policyId/pdf", async (c) => {
    const { downloadPdf } = await import("../controllers/portal_insurance.ts");
    return await downloadPdf(c.req.param("policyId"));
  });

  panelRouter.post("/portal/c/:cid/u/:uid/insurances/:policyId/delete", async (c) => {
    const { deletePolicy } = await import("../controllers/portal_insurance.ts");
    const cid = c.req.param("cid");
    const uid = c.req.param("uid");
    try {
      await deletePolicy(c.req.param("policyId"));
      return c.redirect(
        `/portal/c/${cid}/u/${uid}/insurances?flash=` +
          encodeURIComponent("Apólice apagada.") + "&flashType=success",
      );
    } catch (err) {
      const { extractApiErrorMessage } = await import("./_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro a apagar apólice");
      return c.redirect(
        `/portal/c/${cid}/u/${uid}/insurances?flash=` +
          encodeURIComponent(msg) + "&flashType=danger",
      );
    }
  });
}
