// Routes /admin/c/:cid/users/* - utilizadores do condomínio.

import type { Hono } from "hono";
import { runFormAction } from "../_form_action.ts";
import { parseFlashFromQuery } from "../_flash.ts";
import { getUser, listUsers } from "../../controllers/users.ts";
import { client } from "$panel/client.ts";

export function registerUsersRoutes(panelRouter: Hono): void {
  panelRouter.get("/admin/c/:cid/users", async (c) => {
    const filterRaw = c.req.query("filter");
    const filter = (filterRaw === "admin" || filterRaw === "occupant") ? filterRaw : "all";
    return c.html(await listUsers(parseFlashFromQuery(c), filter));
  });

  panelRouter.get("/admin/c/:cid/users/:id", async (c) => {
    return c.html(await getUser(c.req.param("id"), parseFlashFromQuery(c)));
  });

  panelRouter.get("/admin/c/:cid/users/:id/edit", async (c) => {
    const { getEditUser } = await import("../../controllers/users.ts");
    return c.html(await getEditUser(c.req.param("id"), parseFlashFromQuery(c)));
  });

  panelRouter.post("/admin/c/:cid/users/:id/update", async (c) => {
    const cid = c.req.param("cid");
    const id = c.req.param("id");

    // Self-removal de admin: o redirect default (`users/:id`) iria 403 + loop.
    // Detecta ANTES do update para redirecionar a /choose-condominium ou /logout.
    const form = (await c.req.parseBody()) as Record<string, string | File>;
    const { currentUser } = await import("$panel/context.ts");
    const me = currentUser();
    const isSelfRemovingAdmin = me !== null &&
      me.id === id &&
      form.isManagerSubmitted !== undefined &&
      String(form.isManager ?? "") !== "true";

    try {
      const { updateUser } = await import("../../controllers/users.ts");
      await updateUser(id, form);
    } catch (err) {
      const { extractApiErrorMessage } = await import("../_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro ao atualizar.");
      return c.redirect(
        `/admin/c/${cid}/users/${id}/edit?flash=${encodeURIComponent(msg)}&flashType=danger`,
      );
    }

    if (isSelfRemovingAdmin && me) {
      const otherCondos = me.managedCondominiumIds.filter((other) => other !== cid);
      if (otherCondos.length > 0) {
        return c.redirect(
          `/choose-condominium?flash=${
            encodeURIComponent(
              "Removeste o teu acesso de administrador a este condomínio. Escolhe outro condomínio para continuar.",
            )
          }&flashType=info`,
        );
      }
      // Sem outro condo gerido → forçar logout (cookie é limpo no /logout
      // handler). User pode voltar a entrar com outra conta se aplicável.
      return c.redirect(`/logout`);
    }

    return c.redirect(
      `/admin/c/${cid}/users/${id}?flash=${
        encodeURIComponent("Utilizador atualizado.")
      }&flashType=success`,
    );
  });

  panelRouter.post("/admin/c/:cid/users/:id/delete", (c) => {
    const id = c.req.param("id");
    return runFormAction(c, async () => {
      const { deleteUser } = await import("../../controllers/users.ts");
      await deleteUser(id);
    }, {
      successPath: "users",
      successMsg: "Utilizador removido deste condomínio.",
      errorPath: `users/${id}`,
      errorPrefix: "Erro ao remover",
    });
  });

  // ── Reset assistido de password ───────────────────────────────────────────
  // Devolve sempre HTML (nunca redirect): a password temporária vai no corpo
  // da página e não pode passar por query string. HTMX troca só o cartão.
  panelRouter.post("/admin/c/:cid/users/:id/reset-password", async (c) => {
    const id = c.req.param("id");
    try {
      const { resetUserPassword } = await import("../../controllers/users.ts");
      return c.html(await resetUserPassword(id));
    } catch (err) {
      // Erro renderiza o mesmo cartão com a mensagem lá dentro: um redirect
      // com flash não sobreviveria ao `hx-select` do swap.
      const { extractApiErrorMessage } = await import("../_form_error.ts");
      const { getUser } = await import("../../controllers/users.ts");
      const error = extractApiErrorMessage(err, "Erro ao repor a password.");
      return c.html(await getUser(id, null, { error }));
    }
  });

  // ── Convidar / re-enviar convite a um utilizador que ainda não logou ──────
  // HTMX: OOB swap do botão ("convidar" -> "reenviar") + toast; non-HTMX redirect.
  panelRouter.post("/admin/c/:cid/users/:userId/invite", async (c) => {
    const userId = c.req.param("userId");
    const cid = c.req.param("cid");
    const { render } = await import("../../render.ts");
    const { htmxAction } = await import("../_htmx_response.ts");

    // Lookup por id (getUser), não a lista toda. getUser devolve occupantId
    // (necessário para o endpoint per-occupant) + estado de cooldown, em
    // paridade com a listagem (ver retrieve.ts).
    const before = await client.admin.getUser(userId).then((r) => r.data).catch(() => null);
    const occupantId = before?.occupantId ?? null;
    if (!occupantId) {
      const msg = "Utilizador sem ocupante associado neste condomínio.";
      if (c.req.header("HX-Request") === "true") {
        return c.html(
          await render("pages/reconciliation/_toast.vto", {
            toast: { type: "error", message: msg },
          }),
        );
      }
      return c.redirect(`/admin/c/${cid}/users?flash=${encodeURIComponent(msg)}&flashType=danger`);
    }

    // Mutação via htmxAction (ADR 0030): HTMX (OOB + toast) e fallback non-HTMX
    // (redirect com flash) num só sítio. Erros (incl. 422 COOLDOWN_ACTIVE)
    // viram toast/flash automaticamente, via Client tipado.
    return htmxAction(c, {
      action: () => client.admin.inviteOccupant(occupantId).then((r) => r.data),
      renderSuccess: async (res) => {
        // Re-fetch por id para o swap OOB reflectir o novo estado de cooldown.
        const after = await client.admin.getUser(userId).then((r) => r.data).catch(() => before);
        const [partial, toast] = await Promise.all([
          render("partials/user_invite_button.vto", {
            user: after,
            currentCondominiumId: cid,
            oob: true,
          }),
          render("pages/reconciliation/_toast.vto", {
            toast: {
              type: "success",
              message: `Convite enviado para ${res?.sentTo ?? "o utilizador"}.`,
            },
          }),
        ]);
        return partial + toast;
      },
      redirectPath: "users",
      successMsg: (res) => `Convite enviado para ${res?.sentTo ?? "o utilizador"}.`,
      errorPrefix: "Erro ao convidar",
    });
  });
}
