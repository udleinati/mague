// POST handlers do panel: parseBody -> controller(form) -> redirect com flash
// (success/danger). Convenções: paths condo-relativos (`condoUrl()`);
// `errorPath` default = `successPath`; quando `successPath` é função, `errorPath`
// é obrigatório (não há `result` no caminho de erro).

import type { Context } from "hono";
import { condoUrl } from "../urls.ts";
import { extractApiErrorMessage } from "./_form_error.ts";
import { refererQueryAppend } from "./_referer.ts";

export type FlashType = "success" | "warning" | "info" | "danger";

export interface FormActionOptions<T> {
  /** Path condo-relativo (ex: "receipts/pending") OU função baseada no result. */
  successPath: string | ((result: T) => string);
  /** Mensagem de sucesso. String fixa OU função baseada no result. */
  successMsg: string | ((result: T) => string);
  /** Tipo do flash em sucesso. Default "success" ("warning" p/ sucesso parcial). */
  successFlashType?: FlashType | ((result: T) => FlashType);
  /** Path do flash de erro. Default `successPath` (string); obrigatório quando
   *  `successPath` é função. Pode ser função do form (ex: `?kind=${form.kind}`). */
  errorPath?: string | ((form: Record<string, string | File>) => string);
  /** Prefixo do erro fallback. Só usado quando o erro não tem `data.error.message`. */
  errorPrefix: string;
  /** Default true: apende a query string do `Referer` (preserva filtros). Opt-out
   *  quando os filtros não são relevantes (ex: "criar X -> ir para X/:id"). */
  preserveQuery?: boolean;
}

// `successPath` função sem `errorPath` explícito é programmer error.
function resolveErrorPath<T>(
  opts: FormActionOptions<T>,
  form: Record<string, string | File>,
): string {
  if (typeof opts.errorPath === "function") return opts.errorPath(form);
  if (typeof opts.errorPath === "string") return opts.errorPath;
  if (typeof opts.successPath === "string") return opts.successPath;
  throw new Error(
    "runFormAction: errorPath é obrigatório quando successPath é função (não há result no caminho de erro)",
  );
}

// URL condo-relativa com flash. Apende com `&` se o path já tiver query string.
function flashRedirectUrl(path: string, msg: string, type: FlashType): string {
  const sep = path.includes("?") ? "&" : "?";
  return condoUrl(`${path}${sep}flash=${encodeURIComponent(msg)}&flashType=${type}`);
}

// Controller de POST com sucesso/erro + redirect com flash (sempre 302).
// Preserva por default os filtros do `Referer` (opt-out: `preserveQuery: false`).
export async function runFormAction<T>(
  c: Context,
  action: (form: Record<string, string | File>) => Promise<T>,
  opts: FormActionOptions<T>,
): Promise<Response> {
  const form = (await c.req.parseBody()) as Record<string, string | File>;
  // Append da query do Referer só p/ listagens (path sem `?` nem `/`): evita
  // propagar filtros de listagem para a página de detalhe (ex: `charges/abc`).
  const preserve = opts.preserveQuery !== false;
  const refQs = preserve ? refererQueryAppend(c) : "";
  const appendQs = (path: string): string => {
    if (!refQs) return path;
    if (path.includes("?")) return path;
    if (path.includes("/")) return path;
    return path + refQs;
  };

  try {
    const result = await action(form);
    const path = typeof opts.successPath === "function"
      ? opts.successPath(result)
      : opts.successPath;
    const msg = typeof opts.successMsg === "function" ? opts.successMsg(result) : opts.successMsg;
    const type: FlashType = typeof opts.successFlashType === "function"
      ? opts.successFlashType(result)
      : opts.successFlashType ?? "success";
    return c.redirect(flashRedirectUrl(appendQs(path), msg, type));
  } catch (err) {
    const errPath = resolveErrorPath(opts, form);
    const msg = extractApiErrorMessage(err, `${opts.errorPrefix}.`);
    return c.redirect(flashRedirectUrl(appendQs(errPath), msg, "danger"));
  }
}
