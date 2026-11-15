import type { MiddlewareHandler } from "hono";
import { HttpError } from "./error.ts";
import type { ApiEnv } from "./api_auth.ts";

/**
 * Gate de `/v1/super/*`: exige `role === 'super'`. `apiAuth` só autentica,
 * sem isto qualquer user autenticado chegaria aos endpoints super-admin.
 */
export function requireSuperRole(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const role = c.get("role");
    if (role !== "super") {
      throw new HttpError(403, "Acesso restrito a super-administradores");
    }
    await next();
  };
}
