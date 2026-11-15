import type { Context } from "hono";
import { HttpError } from "$api/middleware/error.ts";

/**
 * Lê o condomínio-scope do path `/v1/admin/condominiums/:cid/...`. Retorna o ID
 * ou atira 400 se não existir.
 *
 * O middleware apiAuth já validou que o actor autenticado tem acesso
 * a este cid (ver middleware/api_auth.ts); aqui só lemos o valor.
 */
export function requireCondominiumId(ctx: Context): string {
  const cid = ctx.req.param("cid") ?? ctx.get("condominiumId");
  if (!cid) {
    throw new HttpError(400, "Condomínio em falta no path (/admin/condominiums/:cid/...)");
  }
  return cid;
}
