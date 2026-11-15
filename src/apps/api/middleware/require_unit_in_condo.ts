import type { MiddlewareHandler } from "hono";
import { HttpError } from "./error.ts";
import type { ApiEnv } from "./api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";

/**
 * Gate de tenant para `/units/:unitId/...` no admin: confirma que a `:unitId`
 * pertence ao `:cid`. Sem isto, handlers que carregam fração/ocupante por
 * `id`/`unitId` permitiam cross-tenant IDOR (admin de A sobre dados de B).
 * 404 (não 403) para não vazar existência. Pressupõe `apiAuth` + `requireAdminRole`.
 */
export function requireUnitInCondo(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const cid = requireCondominiumId(c);
    const unitId = requireParam(c, "unitId");

    const unit = await postgres.query((db) =>
      db.query.unit.findFirst({
        where: byIdInCondo(schema.unit, unitId, cid),
        columns: { id: true },
      })
    );
    if (!unit) throw new HttpError(404, "Fração não encontrada");

    await next();
  };
}
