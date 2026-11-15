// Responses HTMX-aware em handlers de mutação (repetido em tickets, inspections,
// pathologies, charges). Cada caller passa `renderFragment` (HTML a fazer swap,
// htmx extrai a região via hx-select) e `redirectPath` (fallback non-HTMX).
// O helper só escolhe entre devolver HTML e redirecionar; o target vive no markup.
// Ver ADR 0026 (HTMX swaps preservam scroll).

import type { Context } from "hono";
import { condoUrl } from "../urls.ts";
import { extractApiErrorMessage } from "./_form_error.ts";
import { runFormAction } from "./_form_action.ts";
import { render } from "../render.ts";

export type FlashType = "success" | "danger" | "warning" | "info";

export interface HtmxOrRedirectOpts {
  /** Render que produz o HTML quando é HX-Request. Recebe a flash para o
   *  caso de o show poder mostrar a mensagem in-page (toast). */
  renderFragment: (
    flash: { type: FlashType; message: string },
  ) => Promise<string>;
  /** Path condo-relativo para o redirect normal. Não inclui condo prefix
   *  - o helper aplica `condoUrl(...)`. */
  redirectPath: string;
  /** Mensagem para o flash (success ou erro). */
  message: string;
  /** Tipo do flash. Default "success". */
  flashType?: FlashType;
}

// HX-Request: true -> c.html(renderFragment); sem header -> redirect com flash.
// Sucesso e erro seguem o mesmo flow; o caller varia `flashType`.
export async function htmxOrRedirect(
  c: Context,
  opts: HtmxOrRedirectOpts,
): Promise<Response> {
  const flashType: FlashType = opts.flashType ?? "success";
  if (c.req.header("HX-Request") === "true") {
    const html = await opts.renderFragment({ type: flashType, message: opts.message });
    return c.html(html);
  }
  const sep = opts.redirectPath.includes("?") ? "&" : "?";
  return c.redirect(
    condoUrl(
      `${opts.redirectPath}${sep}flash=${encodeURIComponent(opts.message)}&flashType=${flashType}`,
    ),
  );
}

// ─── htmxAction: execução + branching HTMX+toast OU redirect com flash ──────
// Compõe `runFormAction` (non-HTMX) com try/catch + OOB partial+toast (HTMX),
// substituindo o branching `if (isHtmx)` manual replicado em dezenas de routes.

export interface HtmxActionOpts<T> {
  /** Lógica a executar - throw em caso de erro. Recebe o form (parseBody). */
  action: (form: Record<string, string | File>) => Promise<T>;
  /** HTMX success: HTML resposta (partial OOB) a partir do resultado da `action`.
   *  Inclui o próprio toast (recomendado para uniformidade). */
  renderSuccess: (result: T) => Promise<string>;
  /** Path condo-relativo para o fallback non-HTMX (redirect). */
  redirectPath: string;
  /** Mensagem de sucesso. String fixa OU função do resultado. */
  successMsg: string | ((result: T) => string);
  /** Prefixo da mensagem de erro fallback. Default `"Erro"`. */
  errorPrefix?: string;
}

// Branching HX-Request + try/catch. HTMX: erro -> toast vermelho, ok ->
// renderSuccess(T). Non-HTMX: redirect com flashType danger/success.
export async function htmxAction<T>(
  c: Context,
  opts: HtmxActionOpts<T>,
): Promise<Response> {
  const isHtmx = c.req.header("HX-Request") === "true";

  if (!isHtmx) {
    return runFormAction(c, opts.action, {
      successPath: opts.redirectPath,
      successMsg: typeof opts.successMsg === "function" ? opts.successMsg : opts.successMsg,
      errorPrefix: opts.errorPrefix ?? "Erro",
    });
  }

  const form = (await c.req.parseBody()) as Record<string, string | File>;
  try {
    const result = await opts.action(form);
    return c.html(await opts.renderSuccess(result));
  } catch (err) {
    const msg = extractApiErrorMessage(err, `${opts.errorPrefix ?? "Erro"}.`);
    const toastHtml = await render("pages/reconciliation/_toast.vto", {
      toast: { type: "error", message: msg },
    });
    return c.html(toastHtml);
  }
}
