// Auth + sessão: login, logout, accept-invite, password recovery,
// change-password. Não tem `condoUrl`/`als` deps porque corre antes do
// middleware que injecta a sessão. Controllers carregados via dynamic
// import para evitar circular deps com o middleware.

import type { Hono } from "hono";
import { parseFormString } from "$panel/libs/form_parsing.ts";

export function registerAuthRoutes(panelRouter: Hono): void {
  // ── Auth ───────────────────────────────────────────────────────────────────
  panelRouter.get("/login", async (c) => {
    const { loginPage } = await import("../controllers/auth.ts");
    const { getCookie } = await import("hono/cookie");
    const params: Record<string, string> = {};
    for (const [k, v] of new URL(c.req.url).searchParams.entries()) params[k] = v;
    // Cookie `remembered_email` definido no POST /login quando o user marca
    // "Lembrar email". Pré-preenche o input para evitar re-escrever em cada
    // sessão. Não-httpOnly: pode ser lido por JS (não é credencial; só hint).
    const remembered = getCookie(c, "remembered_email");
    if (remembered) params.rememberedEmail = remembered;
    return c.html(await loginPage(params));
  });

  // ── Aceitar convite ───────────────────────────────────────────────────────
  panelRouter.get("/accept-invite", async (c) => {
    const { previewInvitePage } = await import("../controllers/auth.ts");
    const url = new URL(c.req.url);
    const token = url.searchParams.get("token") ?? "";
    const params: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) params[k] = v;
    return c.html(await previewInvitePage(token, params));
  });

  panelRouter.post("/accept-invite", async (c) => {
    const { acceptInvite, sanitizeNext } = await import("../controllers/auth.ts");
    const { setCookie } = await import("hono/cookie");
    const { panelConfig } = await import("../config.ts");
    const body = await c.req.parseBody();
    const token = String(body.token ?? "");
    const next = sanitizeNext(typeof body.next === "string" ? body.next : null);
    try {
      const data = await acceptInvite(body as Record<string, string | File>);
      setCookie(c, "token", data.token, {
        path: "/",
        // Cookie maxAge = cap absoluto JWT (ADR 0020). A sessão Valkey
        // expira por idle TTL muito antes deste valor; cookie é só transporte.
        maxAge: panelConfig.sessionExpiryDays * 60 * 60 * 24,
        sameSite: "Lax",
        httpOnly: true,
      });
      // Honra `next` (ex: convite vindo do email do recibo); senão default abaixo.
      if (next) return c.redirect(next);
      if (data.user.role === "occupant") {
        const { loadSession } = await import("../controllers/auth.ts");
        const me = await loadSession(data.token);
        const first = me?.occupantUnits?.[0];
        if (first) {
          return c.redirect(`/portal/c/${first.condominiumId}/u/${first.unitId}`);
        }
      }
      return c.redirect("/choose-condominium");
    } catch (err) {
      const { extractApiErrorMessage } = await import("./_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro ao aceitar convite.");
      const qs = new URLSearchParams({ token, flash: msg, flashType: "danger" });
      if (next) qs.set("next", next);
      return c.redirect(`/accept-invite?${qs.toString()}`);
    }
  });

  // ── Forgot / Reset ────────────────────────────────────────────────────────
  panelRouter.get("/forgot-password", async (c) => {
    const { forgotPasswordPage } = await import("../controllers/auth.ts");
    const params: Record<string, string> = {};
    for (const [k, v] of new URL(c.req.url).searchParams.entries()) params[k] = v;
    return c.html(await forgotPasswordPage(params));
  });

  panelRouter.post("/forgot-password", async (c) => {
    const { forgotPassword } = await import("../controllers/auth.ts");
    const body = await c.req.parseBody();
    await forgotPassword(body as Record<string, string | File>);
    // Sempre devolve "se existe, recebes". Mensagem genérica para não vazar.
    return c.redirect(
      `/forgot-password?flash=${
        encodeURIComponent(
          "Se a conta existir, receberás um email com instruções nos próximos minutos.",
        )
      }&flashType=info`,
    );
  });

  panelRouter.get("/reset-password", async (c) => {
    const { resetPasswordPage } = await import("../controllers/auth.ts");
    const url = new URL(c.req.url);
    const token = url.searchParams.get("token") ?? "";
    const params: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) params[k] = v;
    return c.html(await resetPasswordPage(token, params));
  });

  panelRouter.post("/reset-password", async (c) => {
    const { resetPassword, loadSession } = await import("../controllers/auth.ts");
    const { setCookie } = await import("hono/cookie");
    const { panelConfig } = await import("../config.ts");
    const body = await c.req.parseBody();
    const token = String(body.token ?? "");
    try {
      const data = await resetPassword(body as Record<string, string | File>);
      setCookie(c, "token", data.token, {
        path: "/",
        // Cookie maxAge = cap absoluto JWT (ADR 0020). A sessão Valkey
        // expira por idle TTL muito antes deste valor; cookie é só transporte.
        maxAge: panelConfig.sessionExpiryDays * 60 * 60 * 24,
        sameSite: "Lax",
        httpOnly: true,
      });
      // Mesma lógica do login: occupant vai para portal, restante para choose.
      if (data.user.role === "occupant") {
        const me = await loadSession(data.token);
        const first = me?.occupantUnits?.[0];
        if (first) {
          return c.redirect(`/portal/c/${first.condominiumId}/u/${first.unitId}`);
        }
      }
      return c.redirect("/choose-condominium");
    } catch (err) {
      const { extractApiErrorMessage } = await import("./_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro ao definir password.");
      return c.redirect(
        `/reset-password?token=${encodeURIComponent(token)}&flash=${
          encodeURIComponent(msg)
        }&flashType=danger`,
      );
    }
  });

  panelRouter.post("/login", async (c) => {
    const { authenticate, loadSession } = await import("../controllers/auth.ts");
    const { setCookie, deleteCookie } = await import("hono/cookie");
    const { panelConfig } = await import("../config.ts");
    const body = await c.req.parseBody();
    // "Lembrar email" - guarda só o identifier digitado (não a password) num
    // cookie próprio. Sobrevive 1 ano. Limpo se o user submeter sem o checkbox.
    const wantsRemember = body?.rememberEmail === "1" || body?.rememberEmail === "on";
    const rawIdentifier = typeof body?.identifier === "string" ? body.identifier.trim() : "";
    if (wantsRemember && rawIdentifier && rawIdentifier.length <= 254) {
      setCookie(c, "remembered_email", rawIdentifier, {
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
        sameSite: "Lax",
      });
    } else if (!wantsRemember) {
      deleteCookie(c, "remembered_email", { path: "/" });
    }
    // `next` vem do hidden input do form (propagado do middleware quando o
    // user tentou aceder uma URL autenticada deslogado). Validamos para
    // evitar open-redirect: só /admin/* e /portal/*, sem URLs externas.
    const rawNext = typeof body?.next === "string" ? body.next : null;
    const validNext = (function (n: string | null): string | null {
      if (!n) return null;
      if (n.length > 2000) return null;
      if (!n.startsWith("/")) return null;
      if (n.startsWith("//")) return null;
      if (n.includes("\\")) return null;
      if (n.startsWith("/login") || n.startsWith("/logout")) return null;
      if (!n.startsWith("/admin/") && !n.startsWith("/portal/")) return null;
      return n;
    })(rawNext);
    try {
      const data = await authenticate(body as Record<string, string | File>);
      // Cookie `token` guarda o JWT (HS256 sobre o sid).
      setCookie(c, "token", data.token, {
        path: "/",
        // Cookie maxAge = cap absoluto JWT (ADR 0020). A sessão Valkey
        // expira por idle TTL muito antes deste valor; cookie é só transporte.
        maxAge: panelConfig.sessionExpiryDays * 60 * 60 * 24,
        sameSite: "Lax",
        httpOnly: true,
      });
      // Se o user veio de uma URL específica (next), respeitamos - desde que
      // o scope esteja alinhado com o role. Cross-scope (occupant a tentar
      // /admin/...) cai pelo middleware com 404 quando lá chegar; portanto
      // só validamos a forma do path, não o role.
      if (validNext) {
        if (data.user.role === "occupant" && !validNext.startsWith("/portal/")) {
          // Occupant a tentar /admin/* → segue a rota normal (1ª fração).
        } else if (data.user.role !== "occupant" && validNext.startsWith("/portal/")) {
          // Admin/super a tentar /portal/* → permitido (impersonate-like).
          return c.redirect(validNext);
        } else {
          return c.redirect(validNext);
        }
      }
      if (data.user.role === "occupant") {
        // /me traz as frações (login só devolve user info básica).
        const me = await loadSession(data.token);
        const units = me?.occupantUnits ?? [];
        if (units.length === 0) {
          // Admin removeu a unit_occupant antes do user aceitar: erro vs loop.
          return c.redirect(
            `/login?flash=${
              encodeURIComponent(
                "A tua conta não está associada a nenhuma fração. Contacta a administração.",
              )
            }&flashType=danger`,
          );
        }
        // 1ª fração (cid + uid no URL); switcher no layout permite mudar.
        const first = units[0];
        return c.redirect(`/portal/c/${first.condominiumId}/u/${first.unitId}`);
      }
      return c.redirect("/choose-condominium");
    } catch (err) {
      const { extractApiErrorMessage } = await import("./_form_error.ts");
      const msg = extractApiErrorMessage(err, "Credenciais inválidas");
      // Preserva `next` no redirect de erro - quando o user reentra credenciais.
      const nextParam = validNext ? `&next=${encodeURIComponent(validNext)}` : "";
      // Preserva o identifier digitado para o user não ter que reescrever o
      // email/NIF quando só errou a password. Limite de 254 chars (RFC 5321
      // email length) para evitar URLs gigantes via input malicioso.
      const idParam = rawIdentifier && rawIdentifier.length <= 254
        ? `&identifier=${encodeURIComponent(rawIdentifier)}`
        : "";
      return c.redirect(
        `/login?flash=${encodeURIComponent(msg)}&flashType=danger${nextParam}${idParam}`,
      );
    }
  });

  // Handler partilhado: aceita GET e POST. GET é usado pelo link de "Sair"
  // no menu (mais fiável que um <form> dentro de dropdown - imune a JS/CSS
  // a esconder o button antes do submit default). Protegido contra CSRF
  // pelo SameSite=Lax do cookie.
  async function handleLogout(c: import("hono").Context) {
    const { getCookie, deleteCookie } = await import("hono/cookie");
    const { logout } = await import("../controllers/auth.ts");
    const token = getCookie(c, "token");
    if (token) await logout(token);
    deleteCookie(c, "token", { path: "/" });
    return c.redirect("/login");
  }
  panelRouter.get("/logout", handleLogout);
  panelRouter.post("/logout", handleLogout);

  panelRouter.post("/change-password", async (c) => {
    const { getCookie } = await import("hono/cookie");
    const { changePassword } = await import("../controllers/auth.ts");
    const token = getCookie(c, "token");
    if (!token) return c.redirect("/login");

    const form = await c.req.parseBody();
    const current = String(form.currentPassword ?? "");
    const next = String(form.newPassword ?? "");
    const confirm = String(form.confirm_password ?? "");

    // Referer nos permite voltar à página de onde o modal foi aberto.
    const referer = c.req.header("referer");
    const backUrl = referer ? new URL(referer) : new URL("/", c.req.url);
    backUrl.searchParams.delete("flash");
    backUrl.searchParams.delete("flashType");

    try {
      await changePassword(token, current, next, confirm);
      backUrl.searchParams.set("flash", "Senha alterada com sucesso.");
      backUrl.searchParams.set("flashType", "success");
    } catch (err) {
      const { extractApiErrorMessage } = await import("./_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro ao alterar senha.");
      backUrl.searchParams.set("flash", msg);
      backUrl.searchParams.set("flashType", "danger");
    }
    return c.redirect(backUrl.pathname + backUrl.search);
  });

  // POST /set-nif  body: { nif, cid, unitId } - submetido pelo modal
  // "Preencha NIF" do portal. O NIF vive em core.occupant
  // (per-condo) → endpoint /v1/portal/condominiums/:cid/units/:unitId/save-nif.
  panelRouter.post("/set-nif", async (c) => {
    const { getCookie } = await import("hono/cookie");
    const token = getCookie(c, "token");
    if (!token) return c.redirect("/login");
    const form = await c.req.parseBody() as Record<string, string | File>;
    const nif = String(form.nif ?? "").replace(/\s+/g, "").trim();
    const cid = parseFormString(form, "cid");
    const unitId = parseFormString(form, "unitId");

    const referer = c.req.header("referer");
    const back = referer ? new URL(referer) : new URL("/", c.req.url);
    back.searchParams.delete("flash");
    back.searchParams.delete("flashType");

    if (!cid || !unitId) {
      back.searchParams.set("flash", "Contexto de fração em falta.");
      back.searchParams.set("flashType", "danger");
      return c.redirect(back.pathname + back.search);
    }

    // Rota fora do gate do portal: cid e unitId vêm do form, só valem frações do próprio.
    const { currentUser } = await import("../context.ts");
    const owns = (currentUser()?.occupantUnits ?? []).some((u) =>
      u.unitId === unitId && u.condominiumId === cid
    );
    if (!owns) {
      back.searchParams.set("flash", "Fração não acessível.");
      back.searchParams.set("flashType", "danger");
      return c.redirect(back.pathname + back.search);
    }

    try {
      const { Client } = await import("$shared/client/mod.ts");
      const { panelConfig } = await import("../config.ts");
      const client = new Client({
        baseUrl: panelConfig.apiUrl,
        condominiumId: cid,
        defaultHeaders: { Authorization: `Bearer ${token}` },
      });
      await client.portal.saveOccupantNif(unitId, nif);
      back.searchParams.set("flash", "NIF guardado.");
      back.searchParams.set("flashType", "success");
    } catch (err) {
      const { extractApiErrorMessage } = await import("./_form_error.ts");
      const msg = extractApiErrorMessage(err, "Erro ao guardar NIF.");
      back.searchParams.set("flash", msg);
      back.searchParams.set("flashType", "danger");
    }
    return c.redirect(back.pathname + back.search);
  });

  // POST /set-theme  body: { theme: 'light' | 'dark' }
  // Persiste a preferência via API (core.user.theme) e devolve 204. O JS
  // do toggle também atualiza o data-theme + cookie no browser para
  // feedback instantâneo (não esperamos pela resposta para repintar).
  panelRouter.post("/set-theme", async (c) => {
    const { getCookie } = await import("hono/cookie");
    const token = getCookie(c, "token");
    if (!token) return c.body(null, 401);
    const body = await c.req.json().catch(() => ({})) as { theme?: string };
    const theme = (body.theme === "dark" || body.theme === "light") ? body.theme : null;
    const { Client } = await import("$shared/client/mod.ts");
    const { panelConfig } = await import("../config.ts");
    const client = new Client({ baseUrl: panelConfig.apiUrl });
    try {
      await client.auth.saveTheme(token, theme);
      return c.body(null, 204);
    } catch (_e) {
      return c.body(null, 502);
    }
  });
}
