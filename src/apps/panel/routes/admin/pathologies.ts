// Routes /admin/c/:cid/pathologies/* - list/show + CRUD + anexos. Pattern
// alinhado com tickets/documents. Ver ADR 0024.

import type { Context, Hono } from "hono";
import { parseFormString } from "$panel/libs/form_parsing.ts";
import { runFormAction } from "../_form_action.ts";
import { type FlashType, htmxOrRedirect } from "../_htmx_response.ts";

export function registerPathologiesRoutes(panelRouter: Hono): void {
  // HTMX-aware via helper canónico (ADR 0026). `showPathology` ainda ignora a
  // flash; o fallback redirect é que a mostra (sem JS).
  const respondPathology = async (
    c: Context,
    id: string,
    message: string,
    flashType: FlashType = "success",
  ): Promise<Response> => {
    return await htmxOrRedirect(c, {
      message,
      flashType,
      redirectPath: `pathologies/${id}`,
      renderFragment: async () => {
        const { showPathology } = await import("../../controllers/pathology.ts");
        return await showPathology(id);
      },
    });
  };
  panelRouter.get("/admin/c/:cid/pathologies", async (c) => {
    const { listPathologies } = await import("../../controllers/pathology.ts");
    const url = new URL(c.req.url);
    const filter = {
      status: url.searchParams.get("status") || undefined,
    };
    return c.html(await listPathologies(filter));
  });

  panelRouter.get("/admin/c/:cid/pathologies/:id", async (c) => {
    const { showPathology } = await import("../../controllers/pathology.ts");
    return c.html(await showPathology(c.req.param("id")));
  });

  // Criar - vindo do modal "+ Nova patologia" na listagem.
  panelRouter.post("/admin/c/:cid/pathologies", (c) =>
    runFormAction(c, async (form) => {
      const { createPathology } = await import("../../controllers/pathology.ts");
      const created = await createPathology(form);
      return created;
    }, {
      successPath: (created) => `pathologies/${(created as { id: string }).id}`,
      successMsg: "Patologia criada.",
      errorPath: "pathologies",
      errorPrefix: "Erro ao criar patologia",
    }));

  // Update inline do form de detail.
  panelRouter.post("/admin/c/:cid/pathologies/:id/update", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const { updatePathology } = await import("../../controllers/pathology.ts");
      await updatePathology(id, form);
    }, {
      successPath: `pathologies/${id}`,
      successMsg: "Patologia atualizada.",
      errorPrefix: "Erro ao atualizar",
    });
  });

  // Mudança rápida de status via segmented control no show.vto.
  panelRouter.post("/admin/c/:cid/pathologies/:id/status", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async (form) => {
      const { changePathologyStatus } = await import("../../controllers/pathology.ts");
      const status = String(form.status ?? "");
      const reason = parseFormString(form, "dismissedReason", { emptyAsNull: true }) ?? undefined;
      // deno-lint-ignore no-explicit-any
      await changePathologyStatus(id, status as any, reason);
    }, {
      successPath: `pathologies/${id}`,
      successMsg: "Estado atualizado.",
      errorPrefix: "Erro ao mudar estado",
    });
  });

  panelRouter.post("/admin/c/:cid/pathologies/:id/delete", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async () => {
      const { deletePathology } = await import("../../controllers/pathology.ts");
      await deletePathology(id);
    }, {
      successPath: "pathologies",
      errorPath: `pathologies/${id}`,
      successMsg: "Patologia eliminada.",
      errorPrefix: "Erro ao eliminar",
    });
  });

  // ── Anexos ──────────────────────────────────────────────────────────────
  panelRouter.get("/admin/c/:cid/pathologies/:id/attachments/:attachmentId", async (c) => {
    const { downloadPathologyAttachment } = await import("../../controllers/pathology.ts");
    return await downloadPathologyAttachment(c.req.param("id"), c.req.param("attachmentId"));
  });

  panelRouter.post("/admin/c/:cid/pathologies/:id/attachments", async (c) => {
    const id = c.req.param("id");
    const fd = await c.req.formData();
    const files = fd.getAll("files")
      .filter((v): v is File => v instanceof File && v.size > 0);
    // Fallback para campo `file` singular se vier do form sem multiple.
    if (files.length === 0) {
      const single = fd.get("file");
      if (single instanceof File && single.size > 0) files.push(single);
    }
    if (files.length === 0) {
      return await respondPathology(c, id, "Seleciona pelo menos um ficheiro.", "danger");
    }
    // Falha parcial: cada ficheiro é independente. Um erro num (tipo não
    // aceite, demasiado grande) não deve descartar os que já entraram nem
    // os seguintes. Reportamos a contagem real ok/falhou.
    const { uploadPathologyAttachment } = await import("../../controllers/pathology.ts");
    let ok = 0;
    const failures: string[] = [];
    for (const file of files) {
      try {
        await uploadPathologyAttachment(id, file);
        ok++;
      } catch (err) {
        const reason = (err instanceof Error ? err.message : String(err)) || "erro desconhecido";
        failures.push(`${file.name || "ficheiro"}: ${reason}`);
      }
    }

    if (failures.length === 0) {
      const msg = ok === 1 ? "Foto carregada." : `${ok} fotos carregadas.`;
      return await respondPathology(c, id, msg, "success");
    }
    if (ok === 0) {
      const msg = failures.length === 1
        ? failures[0]
        : `Nenhum ficheiro carregado. ${failures.join("; ")}`;
      return await respondPathology(c, id, msg, "danger");
    }
    // Sucesso parcial: alguns entraram, outros não.
    return await respondPathology(
      c,
      id,
      `${ok} carregada(s); ${failures.length} falhou(aram): ${failures.join("; ")}`,
      "warning",
    );
  });

  panelRouter.post("/admin/c/:cid/pathologies/:id/attachments/:attachmentId/delete", async (c) => {
    const id = c.req.param("id");
    const attId = c.req.param("attachmentId");
    try {
      const { deletePathologyAttachment } = await import("../../controllers/pathology.ts");
      await deletePathologyAttachment(id, attId);
      return await respondPathology(c, id, "Anexo removido.", "success");
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)) || "Erro a remover anexo.";
      return await respondPathology(c, id, msg, "danger");
    }
  });
}
