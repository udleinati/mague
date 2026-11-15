import type { MiddlewareHandler } from "hono";
import { HttpError } from "./error.ts";
import type { ApiEnv } from "./api_auth.ts";

/**
 * Gate de `/v1/admin/*`: passa super ou manager ativo do cid (pós-ADR 0002),
 * 403 no resto. Fecha o buraco de occupants chegarem a handlers admin.
 * Endpoints de occupants vivem em `/v1/portal/...`. Pressupõe `apiAuth` antes.
 */
export function requireAdminRole(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const role = c.get("role");
    const cid = c.get("condominiumId");
    const managed = c.get("managedCondominiumIds") ?? [];

    if (role === "super") {
      await next();
      return;
    }

    if (cid && managed.includes(cid)) {
      await next();
      return;
    }

    throw new HttpError(403, "Acesso reservado a administradores do condomínio");
  };
}
