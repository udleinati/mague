// Routes /admin/c/:cid/assembly/* - assembleias + ordem do dia + anexos.

import type { Context, Hono } from "hono";
import { condoUrl } from "../../urls.ts";
import { htmxOrRedirect } from "../_htmx_response.ts";
import { parseFormString } from "$panel/libs/form_parsing.ts";

export function registerAssemblyRoutes(panelRouter: Hono): void {
  panelRouter.get("/admin/c/:cid/assembly", async (c) => {
    const { listAssemblies } = await import("../../controllers/assembly.ts");
    return c.html(await listAssemblies());
  });

  panelRouter.get("/admin/c/:cid/assembly/:id", async (c) => {
    const { getAssembly } = await import("../../controllers/assembly.ts");
    return c.html(await getAssembly(c.req.param("id")));
  });

  // PDF da ata - proxy ao endpoint API on-the-fly.
  panelRouter.get("/admin/c/:cid/assembly/:id/minute.pdf", async (c) => {
    const { proxyAssemblyMinutesPdf } = await import("../../controllers/assembly.ts");
    return await proxyAssemblyMinutesPdf(c.req.param("id"));
  });

  // Pré-visualização read-only dos PDFs da convocatória e procuração (proxy API).
  panelRouter.get("/admin/c/:cid/assembly/:id/convocation.pdf", async (c) => {
    const { proxyAssemblyConvocationPdf } = await import("../../controllers/assembly.ts");
    return await proxyAssemblyConvocationPdf(c.req.param("id"));
  });
  panelRouter.get("/admin/c/:cid/assembly/:id/proxy.pdf", async (c) => {
    const { proxyAssemblyProxyPdf } = await import("../../controllers/assembly.ts");
    return await proxyAssemblyProxyPdf(c.req.param("id"));
  });
  // Folha de presenças em branco (proxy API, read-only).
  panelRouter.get("/admin/c/:cid/assembly/:id/attendance-sheet.pdf", async (c) => {
    const { proxyAssemblyAttendanceSheetPdf } = await import("../../controllers/assembly.ts");
    return await proxyAssemblyAttendanceSheetPdf(c.req.param("id"));
  });

  // Pré-visualização (read-only) do email da convocatória de um destinatário: JSON
  // { subject, html } para o modal (mesmo padrão do billing-reminders).
  panelRouter.get(
    "/admin/c/:cid/assembly/:id/convocation/preview/:occupantId/:unitId",
    async (c) => {
      const { previewConvocationEmail } = await import("../../controllers/assembly.ts");
      try {
        const preview = await previewConvocationEmail(
          c.req.param("id"),
          c.req.param("occupantId"),
          c.req.param("unitId"),
        );
        return c.json(preview);
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
    },
  );

  panelRouter.post("/admin/c/:cid/assembly", async (c) => {
    const { createAssembly } = await import("../../controllers/assembly.ts");
    const body = await c.req.parseBody();
    const result = await createAssembly(body as Record<string, string | File>);
    return c.redirect(condoUrl(`assembly/${result.created.id}`));
  });

  // Ordem do dia: HTMX-aware via htmxOrRedirect (ADR 0030). HTMX devolve só o
  // `<tbody>` + toast OOB (preserva scroll); non-htmx faz redirect com flash.
  const agendaHtmxRespond = (
    c: Context,
    id: string,
    action: "added" | "updated" | "removed",
  ): Promise<Response> => {
    const fallback = action === "added"
      ? "Ponto adicionado à ordem do dia"
      : action === "removed"
      ? "Ponto removido da ordem do dia"
      : "Ponto atualizado";
    return htmxOrRedirect(c, {
      renderFragment: async () => {
        const { renderAgendaRows } = await import("../../controllers/assembly.ts");
        return await renderAgendaRows(id, action);
      },
      redirectPath: `assembly/${id}`,
      message: fallback,
    });
  };

  panelRouter.post("/admin/c/:cid/assembly/:id/agenda-items", async (c) => {
    const { addAgendaItem } = await import("../../controllers/assembly.ts");
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    await addAgendaItem(id, body as Record<string, string | File>);
    return await agendaHtmxRespond(c, id, "added");
  });

  // HTML forms não suportam PATCH/DELETE nativamente - usamos POST com sufixo
  // /update e /delete, consistente com outros recursos editáveis do panel.
  panelRouter.post("/admin/c/:cid/assembly/:id/agenda-items/:itemId/update", async (c) => {
    const { updateAgendaItem } = await import("../../controllers/assembly.ts");
    const id = c.req.param("id");
    const itemId = c.req.param("itemId");
    const body = await c.req.parseBody();
    await updateAgendaItem(id, itemId, body as Record<string, string | File>);
    return await agendaHtmxRespond(c, id, "updated");
  });

  panelRouter.post("/admin/c/:cid/assembly/:id/agenda-items/:itemId/delete", async (c) => {
    const { deleteAgendaItem } = await import("../../controllers/assembly.ts");
    const id = c.req.param("id");
    const itemId = c.req.param("itemId");
    await deleteAgendaItem(id, itemId);
    return await agendaHtmxRespond(c, id, "removed");
  });

  panelRouter.post("/admin/c/:cid/assembly/:id/status", async (c) => {
    const { updateAssemblyStatus } = await import("../../controllers/assembly.ts");
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    await updateAssemblyStatus(id, body as Record<string, string | File>);
    return c.redirect(condoUrl(`assembly/${id}`));
  });

  // Cancelar a assembleia (zona perigosa, ADR 0025/0013). Rota dedicada porque
  // o estado alvo (`cancelled`) está na URL, não num campo. API bloqueia
  // held/cancelled (409 ASSEMBLY_LOCKED); cancelar é terminal.
  panelRouter.post("/admin/c/:cid/assembly/:id/cancel", async (c) => {
    const { cancelAssembly } = await import("../../controllers/assembly.ts");
    const id = c.req.param("id");
    const back = condoUrl(`assembly/${id}`);
    try {
      await cancelAssembly(id);
      return c.redirect(
        `${back}?flash=${encodeURIComponent("Assembleia cancelada.")}&flashType=success`,
      );
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)) ||
        "Erro ao cancelar a assembleia.";
      return c.redirect(`${back}?flash=${encodeURIComponent(msg)}&flashType=danger`);
    }
  });

  // Envio da convocatória a todos (bulk). Form POST + redirect com
  // flash das contagens (enviados / sem email / falhas). O botão está
  // desativado em rascunho; a API devolve 422 se ainda assim chegar cá.
  panelRouter.post("/admin/c/:cid/assembly/:id/convocation/send", async (c) => {
    const id = c.req.param("id");
    const back = condoUrl(`assembly/${id}`);
    try {
      const { sendConvocation } = await import("../../controllers/assembly.ts");
      const r = await sendConvocation(id);
      let msg = `Convocatória enviada: ${r.sent} enviada(s)`;
      if (r.noEmail > 0) msg += `, ${r.noEmail} sem email`;
      if (r.skippedCooldown > 0) msg += `, ${r.skippedCooldown} em cooldown`;
      if (r.failed > 0) msg += `, ${r.failed} falhou(aram)`;
      msg += ".";
      // 0 enviadas (ex: todos em cooldown) não é "sucesso" verde - alinha com
      // o lembrete de cobrança (`sentCount === 0 -> warning`).
      const flashType = r.sent === 0 || r.failed > 0 || r.noEmail > 0 ? "warning" : "success";
      return c.redirect(`${back}?flash=${encodeURIComponent(msg)}&flashType=${flashType}`);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)) ||
        "Erro ao enviar a convocatória.";
      return c.redirect(`${back}?flash=${encodeURIComponent(msg)}&flashType=danger`);
    }
  });

  // Reenvio individual a uma pessoa numa fração (ADR 0034). HTMX faz swap do
  // `#convocation-recipients` (ADR 0026); non-htmx redirect com flash. A API
  // impõe cooldown 24h por (pessoa, fração) (422 COOLDOWN_ACTIVE).
  panelRouter.post("/admin/c/:cid/assembly/:id/convocation/send/:occupantId/:unitId", async (c) => {
    const id = c.req.param("id");
    const occupantId = c.req.param("occupantId");
    const unitId = c.req.param("unitId");
    const isHx = c.req.header("HX-Request") === "true";
    const back = condoUrl(`assembly/${id}`);
    const { resendConvocation, renderConvocationRecipients } = await import(
      "../../controllers/assembly.ts"
    );
    try {
      await resendConvocation(id, occupantId, unitId);
      const msg = "Convocatória enviada.";
      if (isHx) {
        return c.html(await renderConvocationRecipients(id, { message: msg, type: "success" }));
      }
      return c.redirect(`${back}?flash=${encodeURIComponent(msg)}&flashType=success`);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)) ||
        "Erro ao enviar a convocatória.";
      if (isHx) {
        return c.html(await renderConvocationRecipients(id, { message: msg, type: "danger" }));
      }
      return c.redirect(`${back}?flash=${encodeURIComponent(msg)}&flashType=danger`);
    }
  });

  panelRouter.post("/admin/c/:cid/assembly/:id/update", async (c) => {
    const { updateAssemblyData } = await import("../../controllers/assembly.ts");
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    await updateAssemblyData(id, body as Record<string, string | File>);
    return c.redirect(condoUrl(`assembly/${id}`));
  });

  // Texto narrativo da ata (introdução / encerramento). HTMX devolve só o
  // `<tbody>` + toast OOB (preserva scroll e modal state); non-htmx redirect.
  panelRouter.post("/admin/c/:cid/assembly/:id/minute-section", async (c) => {
    const { updateMinuteSection, renderMinuteSectionRows } = await import(
      "../../controllers/assembly.ts"
    );
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    const { label } = await updateMinuteSection(
      id,
      body as Record<string, string | File>,
    );
    if (c.req.header("HX-Request") === "true") {
      const html = await renderMinuteSectionRows(id, {
        message: `${label} atualizada`,
      });
      return c.html(html);
    }
    const target = condoUrl(`assembly/${id}`) +
      `?flash=${encodeURIComponent(`${label} atualizada`)}&flashType=success`;
    return new Response(null, { status: 302, headers: { Location: target } });
  });

  // ── Alternar convocatória 1ª ↔ 2ª (Art. 1432.º nº 4 CC) ───────────────────
  panelRouter.post("/admin/c/:cid/assembly/:id/convocation-round", async (c) => {
    const { updateAssemblyConvocationRound } = await import(
      "../../controllers/assembly.ts"
    );
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    const raw = String(body.convocationRound ?? "first");
    const round: "first" | "second" = raw === "second" ? "second" : "first";
    await updateAssemblyConvocationRound(id, round);
    return c.redirect(condoUrl(`assembly/${id}`));
  });

  // ── Presenças (Art. 1432.º + 1431.º nº 5 CC) ──────────────────────────────
  panelRouter.post("/admin/c/:cid/assembly/:id/attendees", async (c) => {
    const { addAttendee } = await import("../../controllers/assembly.ts");
    const id = c.req.param("id");
    const body = await c.req.parseBody();
    await addAttendee(id, body as Record<string, string | File>);
    // HTMX: client-side redirect via header (preserva a barra de progresso).
    const target = condoUrl(`assembly/${id}`);
    if (c.req.header("HX-Request") === "true") {
      return c.body(null, 200, { "HX-Redirect": target });
    }
    return c.redirect(target);
  });

  panelRouter.post("/admin/c/:cid/assembly/:id/attendees/:aid/delete", async (c) => {
    const { deleteAttendee } = await import("../../controllers/assembly.ts");
    const id = c.req.param("id");
    const aid = c.req.param("aid");
    await deleteAttendee(id, aid);
    const target = condoUrl(`assembly/${id}`);
    if (c.req.header("HX-Request") === "true") {
      return c.body(null, 200, { "HX-Redirect": target });
    }
    return c.redirect(target);
  });

  // ── Assinatura da ata (Art. 1434.º CC) ───────────────────────────────────
  panelRouter.post("/admin/c/:cid/assembly/:id/sign-minutes", async (c) => {
    const { signMinutes, renderSignatureBlock } = await import(
      "../../controllers/assembly.ts"
    );
    const id = c.req.param("id");
    const body = await c.req.parseBody() as Record<string, string | File>;
    await signMinutes(id, body);
    const wasSigned = parseFormString(body, "minutesSignedAt") !== "";
    const message = wasSigned ? "Assinatura guardada" : "Ata assinada";
    if (c.req.header("HX-Request") === "true") {
      const html = await renderSignatureBlock(id, { message });
      return c.html(html);
    }
    const url = condoUrl(`assembly/${id}`) +
      `?flash=${encodeURIComponent(message)}&flashType=success`;
    return new Response(null, { status: 302, headers: { Location: url } });
  });

  // ── Anexos da assembleia (upload / serve / delete) ────────────────────────
  panelRouter.post("/admin/c/:cid/assembly/:id/attachments", async (c) => {
    const id = c.req.param("id");
    const fd = await c.req.formData();
    const files = fd.getAll("files")
      .filter((v): v is File => v instanceof File && v.size > 0);
    // Fallback para campo `file` singular (forms antigos / sem multiple).
    if (files.length === 0) {
      const single = fd.get("file");
      if (single instanceof File && single.size > 0) files.push(single);
    }
    const redirectFlash = (msg: string, type: "success" | "warning" | "danger") =>
      c.redirect(condoUrl(`assembly/${id}?flash=${encodeURIComponent(msg)}&flashType=${type}`));

    if (files.length === 0) {
      return redirectFlash("Seleciona pelo menos um ficheiro.", "danger");
    }
    // Falha parcial: cada ficheiro é independente. Um erro num (tipo não
    // aceite, demasiado grande) não descarta os que já entraram nem os
    // seguintes - reportamos a contagem real ok/falhou.
    const { uploadAssemblyAttachment } = await import("../../controllers/assembly.ts");
    let ok = 0;
    const failures: string[] = [];
    for (const file of files) {
      try {
        await uploadAssemblyAttachment(id, file);
        ok++;
      } catch (err) {
        const reason = (err instanceof Error ? err.message : String(err)) || "erro desconhecido";
        failures.push(`${file.name || "ficheiro"}: ${reason}`);
      }
    }
    if (failures.length === 0) {
      return redirectFlash(ok === 1 ? "Ficheiro anexado." : `${ok} ficheiros anexados.`, "success");
    }
    if (ok === 0) {
      return redirectFlash(
        failures.length === 1 ? failures[0] : `Nenhum ficheiro anexado. ${failures.join("; ")}`,
        "danger",
      );
    }
    return redirectFlash(
      `${ok} anexado(s); ${failures.length} falhou(aram): ${failures.join("; ")}`,
      "warning",
    );
  });

  panelRouter.get("/admin/c/:cid/assembly/:id/attachments/:aid", async (c) => {
    const { proxyDownload } = await import("../../libs/download_proxy.ts");
    const { client } = await import("../../client.ts");
    const id = c.req.param("id");
    const aid = c.req.param("aid");
    const upstream = await client.admin.downloadStream(`/assemblies/${id}/attachments/${aid}`);
    return proxyDownload(upstream);
  });

  panelRouter.post("/admin/c/:cid/assembly/:id/attachments/:aid/delete", async (c) => {
    const { deleteAssemblyAttachment } = await import("../../controllers/assembly.ts");
    const id = c.req.param("id");
    const aid = c.req.param("aid");
    await deleteAssemblyAttachment(id, aid);
    return c.redirect(condoUrl(`assembly/${id}`));
  });
}
