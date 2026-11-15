// Logging estruturado de erros server-side (onError do panel, errorHandler do
// API). Produz uma linha-summary grep-friendly + stack, para `docker logs`
// captar erros que de outro modo só dariam flash no browser.
// Severity: "info" = 4xx esperado (sem stack); "warn" = 404/409 (stack curto);
// "error" = 5xx/exceções (stack completo).

export type ErrorSeverity = "info" | "warn" | "error";

export interface ErrorLogContext {
  /** Prefixo do app; aparece em `[<prefix>.<severity>]`. */
  app: string;
  method?: string;
  path?: string;
  status?: number;
  /** Condomínio ativo na request (ALS no panel; path no API). */
  condominiumId?: string | null;
  userEmail?: string | null;
  /** super | manager | occupant. */
  userRole?: string | null;
  /** Origem do erro (ex.: "Vento render", "HTTP client"). */
  source?: string;
  extra?: Record<string, unknown>;
}

// Formata e imprime um erro no stdout. Nunca lança: falhas no próprio
// logging não devem partir a request.
export function logError(
  severity: ErrorSeverity,
  ctx: ErrorLogContext,
  err: unknown,
): void {
  try {
    const tag = `[${ctx.app}.${severity}]`;
    const ts = new Date().toISOString();
    const method = ctx.method ?? "-";
    const path = ctx.path ?? "-";
    const status = ctx.status != null ? String(ctx.status) : "-";
    const condo = ctx.condominiumId ?? "-";
    const user = ctx.userEmail ?? "-";
    const role = ctx.userRole ? ` role=${ctx.userRole}` : "";

    const info = describeError(err);

    // [TAG] TS METHOD PATH STATUS cid=X user=Y role=Z → NAME: MESSAGE
    const summary =
      `${tag} ${ts} ${method} ${path} ${status} cid=${condo} user=${user}${role} → ${info.name}: ${info.message}`;
    // eslint-disable-next-line no-console
    console.error(summary);

    if (info.code) {
      console.error(`    code: ${info.code}`);
    }
    if (ctx.source) {
      console.error(`    source: ${ctx.source}`);
    }
    if (ctx.extra && Object.keys(ctx.extra).length > 0) {
      console.error(`    extra: ${safeStringify(ctx.extra)}`);
    }
    if (info.detail) {
      console.error(`    detail: ${safeStringify(info.detail)}`);
    }

    // Stack: completo em error, primeiras linhas em warn, omisso em info.
    const includeStack = severity === "error" ||
      (severity === "warn" && Deno.env.get("DEBUG_FULL_STACK") !== "true") ||
      Deno.env.get("DEBUG_FULL_STACK") === "true";
    if (includeStack && info.stack) {
      const stackLines = info.stack.split("\n");
      const stackToShow = severity === "warn" ? stackLines.slice(0, 4).join("\n") : info.stack;
      console.error(stackToShow);
    }
  } catch (logErr) {
    // Last-resort: imprime o original sem formatação.
    try {
      // eslint-disable-next-line no-console
      console.error(`[${ctx.app}.error] (logError falhou)`, err, logErr);
    } catch {
      // pass
    }
  }
}

interface DescribedError {
  name: string;
  message: string;
  code?: string;
  detail?: unknown;
  stack?: string;
}

function describeError(err: unknown): DescribedError {
  if (err instanceof Error) {
    // Apanha shapes comuns: AppError com data.error, HttpError, fetch errors.
    const anyErr = err as {
      code?: string;
      statusCode?: number;
      data?: { error?: { code?: string; message?: string; detail?: unknown } };
      detail?: unknown;
    };
    return {
      name: err.name,
      message: anyErr.data?.error?.message ?? err.message,
      code: anyErr.code ?? anyErr.data?.error?.code,
      detail: anyErr.data?.error?.detail ?? anyErr.detail,
      stack: err.stack,
    };
  }
  if (typeof err === "string") {
    return { name: "Error", message: err };
  }
  return {
    name: "UnknownError",
    message: safeStringify(err),
  };
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}
