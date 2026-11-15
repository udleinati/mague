import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { isDev } from "$config/env.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { logError } from "$shared/error_log.ts";

/** Severity heurística por status code. */
function severityFor(status: number): "info" | "warn" | "error" {
  if (status >= 500) return "error";
  if (status === 404 || status === 409 || status === 422) return "warn";
  return "info";
}

function logApiError(c: Context, err: unknown, status: number) {
  // Nunca do header: o cliente escolhe-o e o log passava a mentir sobre o tenant.
  const condo = c.req.param("cid") ?? (c.var as { condominiumId?: string | null }).condominiumId ??
    null;
  const actor = (c.var as { actor?: { email?: string; role?: string } }).actor ?? null;
  logError(severityFor(status), {
    app: "api",
    method: c.req.method,
    path: c.req.path,
    status,
    condominiumId: condo,
    userEmail: actor?.email ?? null,
    userRole: actor?.role ?? null,
  }, err);
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const errorHandler: ErrorHandler = (err, c: Context) => {
  // Rotas `/v1/*` respondem JSON; o resto cai no fallback HTML.
  const isApiRoute = c.req.path.startsWith("/v1/");

  if (err instanceof HttpError) {
    logApiError(c, err, err.status);
    if (isApiRoute) {
      return c.json(
        { error: { code: "HTTP_ERROR", message: err.message } },
        err.status as 400,
      );
    }
    return c.html(renderError(err.status, err.message), err.status as 400);
  }

  if (err instanceof AppError) {
    logApiError(c, err, err.statusCode);
    if (isApiRoute) {
      return c.json(
        { error: { code: err.code, message: err.message, detail: err.detail } },
        err.statusCode as 400,
      );
    }
    return c.html(renderError(err.statusCode, err.message), err.statusCode as 400);
  }

  // Erro inesperado → 500 com stack completa.
  logApiError(c, err, 500);
  const message = isDev ? err.message : "Ocorreu um erro inesperado.";
  if (isApiRoute) {
    return c.json({ error: { code: "UNEXPECTED_ERROR", message } }, 500);
  }
  return c.html(renderError(500, message), 500);
};

export const notFoundHandler: NotFoundHandler = (c: Context) => {
  if (c.req.path.startsWith("/v1/")) {
    return c.json({ error: { code: "NOT_FOUND", message: "Rota não encontrada." } }, 404);
  }
  return c.html(renderError(404, "Página não encontrada."), 404);
};

function renderError(status: number, message: string): string {
  return `<!doctype html>
<html lang="pt">
  <head>
    <meta charset="utf-8">
    <title>Erro ${status} - Mague</title>
    <link rel="stylesheet" href="/static/css/style.css">
  </head>
  <body class="error-page">
    <main class="error-container">
      <h1>Erro ${status}</h1>
      <p>${escapeHtml(message)}</p>
      <a href="/">Voltar ao início</a>
    </main>
  </body>
</html>`;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
