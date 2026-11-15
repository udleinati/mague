// Resolve `panelBaseUrl` para URLs em emails. Aceitar `X-Panel-Base-URL` cego
// permitia phishing (reset link controlado pelo atacante em `/forgot-password`,
// público), por isso o header só passa se o origin estiver na allowlist
// (`env.panelBaseUrl` + `PANEL_BASE_URL_EXTRA` CSV para staging/prod).

import type { Context } from "hono";
import { env } from "$config/env.ts";

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

const allowedOrigins = (() => {
  const set = new Set<string>();
  const main = originOf(env.panelBaseUrl);
  if (main) set.add(main);
  const extra = (Deno.env.get("PANEL_BASE_URL_EXTRA") ?? "").split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const e of extra) {
    const o = originOf(e);
    if (o) set.add(o);
  }
  return set;
})();

/**
 * Origin para links em emails: header `X-Panel-Base-URL` se na allowlist,
 * senão `env.panelBaseUrl`. NUNCA devolve origin não-allowlisted (anti-phishing).
 */
export function safePanelBaseUrl(ctx: Context): string {
  const headerVal = ctx.req.header("x-panel-base-url");
  if (headerVal) {
    const origin = originOf(headerVal);
    if (origin && allowedOrigins.has(origin)) {
      // Devolve o header inteiro (preserva path/query) - origin já validado.
      return headerVal;
    }
  }
  return env.panelBaseUrl;
}
