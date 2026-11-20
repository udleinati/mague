import { Hono } from "hono";
import { serveStatic } from "hono/deno";
import { deleteCookie, getCookie } from "hono/cookie";
import { panelConfig } from "./config.ts";
import { panelRouter } from "./router.ts";
import { als, type Flash, type PanelUser } from "./context.ts";
import { listAccessibleCondominiums, loadSession } from "./controllers/auth.ts";
import { renderNotFound, renderNotFoundNeutral } from "./controllers/errors.ts";
import { logError } from "$shared/error_log.ts";
import { extractApiErrorMessage } from "./routes/_form_error.ts";
import { validateNextPath } from "./libs/next_path.ts";

/** Helper para o onError: agrega contexto ALS para o log. */
function logFromContext(
  severity: "info" | "warn" | "error",
  c: {
    req: { method: string; path: string };
  },
  err: unknown,
  status: number,
) {
  const store = als.getStore();
  logError(severity, {
    app: "panel",
    method: c.req.method,
    path: c.req.path,
    status,
    condominiumId: store?.condominiumId ?? null,
    userEmail: store?.user?.email ?? null,
    userRole: store?.user?.role ?? null,
  }, err);
}

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok", panel: true }));

// ─── Assets estáticos ─────────────────────────────────────────────────
// Favicon + apple-touch-icon + ícones PWA - públicos, servidos antes do
// gate de auth para os browsers os buscarem mesmo em /login.
app.get("/favicon.svg", serveStatic({ path: "./src/apps/panel/static/favicon.svg" }));
app.get("/favicon.ico", serveStatic({ path: "./src/apps/panel/static/favicon.svg" }));
app.get(
  "/apple-touch-icon.png",
  serveStatic({ path: "./src/apps/panel/static/apple-touch-icon.png" }),
);
app.get(
  "/apple-touch-icon-precomposed.png",
  serveStatic({ path: "./src/apps/panel/static/apple-touch-icon.png" }),
);
app.get("/icon-192.png", serveStatic({ path: "./src/apps/panel/static/icon-192.png" }));
app.get("/icon-512.png", serveStatic({ path: "./src/apps/panel/static/icon-512.png" }));
// CSS AOT (Tailwind + daisyUI purgados). Substitui o compilador em runtime
// `cdn.tailwindcss.com`. Regenerar com `deno task build:css`. Ver styles/.
app.get("/app.css", serveStatic({ path: "./src/apps/panel/static/app.css" }));

// Redirect root para a rota de seleção (decide o condo default).
app.get("/", (c) => c.redirect("/choose-condominium"));

const PUBLIC_PATHS = [
  "/login",
  "/health",
  "/accept-invite",
  "/forgot-password",
  "/reset-password",
  // Assets estáticos públicos (favicon + apple-touch-icon + ícones PWA).
  // Os browsers buscam estes paths mesmo antes de o user logar.
  "/favicon.svg",
  "/favicon.ico",
  "/apple-touch-icon.png",
  "/apple-touch-icon-precomposed.png",
  "/icon-192.png",
  "/icon-512.png",
];
// Rotas autenticadas mas sem contexto de condomínio (pre-seleção, logout).
const AUTH_NO_CONDO_PATHS = [
  "/logout",
  "/choose-condominium",
  "/change-password",
  "/portal/exit",
  "/set-theme",
  "/set-nif",
];

// Redirect para /login preservando o path atual em `?next=`.
function redirectToLogin(c: import("hono").Context): Response {
  const url = new URL(c.req.url);
  const candidate = url.pathname + url.search;
  const next = validateNextPath(candidate);
  if (next && next !== "/admin" && next !== "/portal") {
    return c.redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  return c.redirect("/login");
}

// Condo default sem contexto na URL: super → config; manager → 1º gerido.
function defaultCondoFor(user: PanelUser): string {
  if (user.role === "super") return panelConfig.condominiumId;
  return user.managedCondominiumIds[0] ?? panelConfig.condominiumId;
}

// Middleware 1: carrega sessão do cookie `token` (JWT) e mete no ALS.
app.use("*", async (c, next) => {
  const token = getCookie(c, "token") ?? "";
  let user: PanelUser | null = null;
  if (token) {
    const me = await loadSession(token);
    if (me) {
      user = {
        id: me.user.id,
        email: me.user.email,
        name: me.user.name ?? null,
        role: me.user.role,
        theme: (me.user.theme === "dark" || me.user.theme === "light") ? me.user.theme : null,
        termsAcknowledgedAt: me.user.termsAcknowledgedAt ?? null,
        managedCondominiumIds: me.managedCondominiumIds,
        occupantUnits: me.occupantUnits ?? [],
      };
    } else {
      deleteCookie(c, "token", { path: "/" });
    }
  }

  // cid do path /admin/c/<cid>/… ou /portal/c/<cid>/… (vazio fora deles;
  // aceita o legacy `/c/<cid>/`). Portal extrai também unitId de /u/<uid>/…
  // Path descodificado, como o router o vê: no cru, /%75/<uid> escondia a fração do gate.
  const url = new URL(c.req.url);
  const pathname = c.req.path;
  const portalPathMatch = pathname.match(/^\/portal\/c\/([^/]+)\/u\/([^/]+)(\/.*)?$/);
  const portalCidOnlyMatch = !portalPathMatch && pathname.match(/^\/portal\/c\/([^/]+)(\/.*)?$/);
  const adminPathMatch = pathname.match(/^\/admin\/c\/([^/]+)(\/.*)?$/) ??
    pathname.match(/^\/c\/([^/]+)(\/.*)?$/);
  const cidFromPath = portalPathMatch
    ? portalPathMatch[1]
    : portalCidOnlyMatch
    ? portalCidOnlyMatch[1]
    : adminPathMatch
    ? adminPathMatch[1]
    : "";
  // O `uid` no path é a fonte única de verdade da fração ativa.
  const portalUnitId = portalPathMatch ? portalPathMatch[2] : null;

  // Flash de `?flash=…&flashType=…` no ALS → todos os templates via render.ts.
  const flashMsg = url.searchParams.get("flash");
  const flashType = url.searchParams.get("flashType");
  const flash: Flash | null = flashMsg
    ? {
      type: flashType === "danger"
        ? "error"
        : flashType === "warning"
        ? "warning"
        : flashType === "info"
        ? "info"
        : "success",
      message: flashMsg,
    }
    : null;

  // Origin público dos headers do Caddy (dev cai para http://localhost).
  // Vai à API via `X-Panel-Base-URL` para links corretos nos emails.
  const proto = c.req.header("x-forwarded-proto") ?? "http";
  const host = c.req.header("host") ?? `localhost:${panelConfig.port}`;
  const requestOrigin = `${proto}://${host}`;
  const clientIp = c.req.header("x-forwarded-for")?.split(",")[0].trim() || null;

  return als.run(
    { condominiumId: cidFromPath, user, token, portalUnitId, flash, requestOrigin, clientIp },
    () => next(),
  );
});

// Middleware 2: auth gate + validação do cid na URL.
app.use("*", async (c, next) => {
  const pathname = c.req.path;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
  if (isPublic) {
    await next();
    return;
  }

  const store = als.getStore();
  const user = store?.user ?? null;
  if (!user) return redirectToLogin(c);

  // Rotas autenticadas sem contexto de condomínio (logout, choose-condominium)
  const isAuthNoCondo = AUTH_NO_CONDO_PATHS.some((p) =>
    pathname === p || pathname.startsWith(p + "/")
  );

  // ─── Acesso ao /admin/* ─────────────────────────────────────────────
  // Restrito a super + managers. Occupants puros → 404 NEUTRO (sem chrome
  // admin, que daria a sensação errada de "consigo entrar"). Antes de
  // qualquer admin-scoped check.
  const cid = store?.condominiumId ?? "";
  const portalUnitId = store?.portalUnitId ?? null;
  const isAdmin = user.role === "super" || user.managedCondominiumIds.length > 0;
  if (pathname.startsWith("/admin") && !isAdmin) {
    return c.html(
      await renderNotFoundNeutral({
        heading: "Acesso restrito",
        subtitle: "Esta área é apenas para administradores. Volta ao portal do condómino.",
        attemptedPath: pathname,
      }),
      404,
    );
  }

  // ─── Portal scope: /portal/c/<cid>/u/<uid>/... ──────────────────────
  // Anti-IDOR: validamos que `uid` pertence aos occupantUnits do user
  // (super/manager do condo podem aceder a qualquer uid - impersonate).
  if (pathname.startsWith("/portal/c/")) {
    if (!cid) return c.redirect("/choose-condominium");
    if (!portalUnitId) {
      // Sem /u/<uid> - handler /portal/c/:cid redireciona para a 1ª fração.
      await next();
      return;
    }
    const isManagerOfCondo = user.managedCondominiumIds.includes(cid);
    if (user.role !== "super" && !isManagerOfCondo) {
      // A fração tem de ser deste cid: senão a de A abria o portal com B no ALS.
      const owns = (user.occupantUnits ?? []).some((u) =>
        u.unitId === portalUnitId && u.condominiumId === cid
      );
      if (!owns) {
        return c.html(
          await renderNotFoundNeutral({
            heading: "Fração não acessível",
            subtitle: "Não estás associado a esta fração.",
            attemptedPath: pathname,
          }),
          404,
        );
      }
    }

    // ── Aviso de privacidade gate ────────────────────────────────────────
    // 1º acesso ao portal → redirect a /privacy-notice até "OK, entendi".
    // Super + managers exempt (impersonam, não consomem). A própria página
    // /privacy-notice é exempt para evitar loop.
    const isPrivacyNoticeRoute = /^\/portal\/c\/[^/]+\/u\/[^/]+\/privacy-notice(\/.*)?$/.test(
      pathname,
    );
    if (
      user.role !== "super" &&
      !isManagerOfCondo &&
      !user.termsAcknowledgedAt &&
      !isPrivacyNoticeRoute
    ) {
      return c.redirect(`/portal/c/${cid}/u/${portalUnitId}/privacy-notice`);
    }

    await next();
    return;
  }

  // ─── Rotas /portal/* sem cid (ex: /portal/exit) ──────────────────────
  // Não cair no fallback "URL legada → /admin/c/..." (estragava POSTs do portal).
  if (pathname.startsWith("/portal/") || pathname.startsWith("/portal")) {
    await next();
    return;
  }

  // ─── /admin/c/<cid>/... (admins/managers) ────────────────────────────
  const isAdminScoped = pathname.startsWith("/admin/c/") || pathname.startsWith("/c/");
  if (isAdminScoped) {
    if (!cid) return c.redirect("/choose-condominium");
    if (user.role !== "super") {
      if (!user.managedCondominiumIds.includes(cid)) {
        return c.html(
          await renderNotFoundNeutral({
            heading: "Condomínio não acessível",
            subtitle: "Não tens permissão para este condomínio, ou o ID está incorreto.",
            attemptedPath: pathname,
          }),
          404,
        );
      }
    } else {
      const condos = await listAccessibleCondominiums();
      const exists = condos.some((co) => co.id === cid);
      if (!exists) {
        return c.html(
          await renderNotFoundNeutral({
            heading: "Condomínio não encontrado",
            subtitle: "O condomínio indicado na URL não existe.",
            attemptedPath: pathname,
          }),
          404,
        );
      }
    }
  } else if (!isAuthNoCondo) {
    // URL legada de admin (sem prefixo /admin/c/<cid>/) → condo default.
    const fallback = defaultCondoFor(user);
    const target = `/admin/c/${fallback}${pathname}`;
    return c.redirect(target);
  }

  await next();
});

// URLs antigas /c/<cid>/... → /admin/c/<cid>/... (Abril/2026). Mantém
// bookmarks vivos; sunset em ~12 meses quando os logs mostrarem zero hits.
app.all("/c/:cid/*", (c) => {
  const url = new URL(c.req.url);
  const target = `/admin${url.pathname}${url.search}`;
  return c.redirect(target, 308); // 308 preserva método
});

app.route("/", panelRouter);

// Converte ApiError (4xx) em redirect com flash em vez do 500 default.
// Tem de ser `app.onError`, não um middleware try/catch: o `compose` do
// Hono só propaga erros ao errorHandler global, nunca a um middleware pai.
app.onError(async (err, c) => {
  const apiErr = err as {
    statusCode?: number;
    data?: { error?: { code?: string; message?: string } };
    message?: string;
  };
  const isApiError = typeof apiErr?.statusCode === "number" && apiErr.data?.error?.message;

  if (isApiError && c.req.method !== "GET") {
    // Mutation com erro de regra de negócio → redirect com flash (info, não bug).
    logFromContext("info", c, err, apiErr.statusCode!);
    const msg = extractApiErrorMessage(err, apiErr.data!.error!.message!);
    const referer = c.req.header("referer");
    const target = referer ? new URL(referer) : new URL("/", c.req.url);
    target.searchParams.set("flash", msg);
    target.searchParams.set("flashType", "danger");
    return c.redirect(target.pathname + target.search);
  }

  // GET com ApiError 404 (recurso inexistente ou anti-IDOR cid≠recurso) →
  // 404 bonito em vez de 500 plain text.
  if (isApiError && c.req.method === "GET" && apiErr.statusCode === 404) {
    const pathname = new URL(c.req.url).pathname;
    logFromContext("info", c, err, 404);
    const user = als.getStore()?.user ?? null;
    const isAdmin = user ? user.role === "super" || user.managedCondominiumIds.length > 0 : false;
    if (isAdmin) {
      return c.html(
        await renderNotFound({
          heading: "Recurso não encontrado",
          subtitle: apiErr.data!.error!.message ?? "O endereço que seguiste não existe.",
          attemptedPath: pathname,
        }),
        404,
      );
    }
    return c.html(
      await renderNotFoundNeutral({
        heading: "Página não encontrada",
        subtitle: "O endereço que seguiste não existe.",
        attemptedPath: pathname,
      }),
      404,
    );
  }

  // GET com ApiError 4xx não-404 → flash + redirect (mesma lógica do mutation).
  if (
    isApiError && c.req.method === "GET" &&
    apiErr.statusCode && apiErr.statusCode >= 400 && apiErr.statusCode < 500
  ) {
    logFromContext("warn", c, err, apiErr.statusCode);
    const msg = extractApiErrorMessage(err, apiErr.data!.error!.message!);
    const referer = c.req.header("referer");
    const target = referer ? new URL(referer) : new URL("/", c.req.url);
    target.searchParams.set("flash", msg);
    target.searchParams.set("flashType", "danger");
    return c.redirect(target.pathname + target.search);
  }

  // Qualquer outro erro → 500, loggado em severity=error com stack.
  logFromContext("error", c, err, 500);
  return c.text("Internal Server Error", 500);
});

// Fallback: path sem rota → 404 bonito (não autenticado → /login primeiro).
app.notFound(async (c) => {
  const pathname = new URL(c.req.url).pathname;
  const user = als.getStore()?.user ?? null;
  if (!user) return redirectToLogin(c);
  // Occupants puros → 404 NEUTRO (o 404 admin tem chrome confuso para o portal).
  const isAdmin = user.role === "super" || user.managedCondominiumIds.length > 0;
  if (!isAdmin) {
    return c.html(
      await renderNotFoundNeutral({
        heading: "Página não encontrada",
        subtitle: "O endereço que seguiste não existe.",
        attemptedPath: pathname,
      }),
      404,
    );
  }
  return c.html(
    await renderNotFound({
      heading: "Página não encontrada",
      subtitle: "O endereço que seguiste não existe - verifica se está bem escrito.",
      attemptedPath: pathname,
    }),
    404,
  );
});

console.log(`Mague Panel a iniciar em http://localhost:${panelConfig.port}`);

Deno.serve({ port: panelConfig.port, hostname: "0.0.0.0" }, app.fetch);
