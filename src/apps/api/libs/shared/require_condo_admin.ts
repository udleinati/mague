// Gate de autorização "esta request é admin do condomínio actual?". Regra única
// (ADR 0002 + ADR 0009): role "super" OU cid em managedCondominiumIds → ok;
// caso contrário 403. Concentra o check antes replicado inline em 14+ handlers.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { AppError } from "$api/libs/error/app_error.ts";
import type { ApiEnv } from "$api/middleware/api_auth.ts";

/**
 * Garante admin com poderes sobre o condomínio actual; lança 403 caso
 * contrário. Lê o `cid` do contexto (injectado por `apiAuth`). `opts.action`
 * = verbo da acção bloqueada, para uma mensagem de erro mais útil.
 */
export function requireCondoAdmin(
  ctx: Context<ApiEnv>,
  opts?: { action?: string },
): void {
  if (isCondoAdmin(ctx)) return;
  throw new AppError({
    message: opts?.action
      ? `Apenas admin pode ${opts.action}`
      : "Acesso restrito a administradores do condomínio",
    statusCode: STATUS_CODE.Forbidden,
    code: "FORBIDDEN",
  });
}

/**
 * Versão non-throwing - para callers que adaptam o comportamento conforme é
 * admin (e.g. listings que filtram em vez de bloquear). `cid` ausente → false.
 */
export function isCondoAdmin(ctx: Context<ApiEnv>): boolean {
  const cid = ctx.get("condominiumId");
  if (!cid) return false;
  const role = ctx.get("role");
  if (role === "super") return true;
  const managed = ctx.get("managedCondominiumIds") ?? [];
  return managed.includes(cid);
}
