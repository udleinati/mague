import type { MiddlewareHandler } from "hono";
import { HttpError } from "./error.ts";
import type { ApiEnv } from "./api_auth.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { loadUserMembership } from "$api/libs/membership/mod.ts";

/**
 * Auth para `/v1/portal/condominiums/:cid/...`: exige fração ativa no condo
 * (super e managers passam sempre). Valida acesso ao condomínio, não à fração
 * (ver `requirePortalAccessToUnit`). 404 (não 403) para sem-link: evita
 * enumeração de condomínios. Pressupõe `apiAuth` antes.
 */
export function requirePortalAccessToCondo(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const role = c.get("role");
    const cid = c.get("condominiumId");
    const actor = c.get("actor");

    if (!cid) throw new HttpError(400, "condominiumId em falta no path");
    if (!actor) throw new HttpError(401, "Sessão obrigatória");

    if (role === "super") {
      await next();
      return;
    }

    const managed = c.get("managedCondominiumIds") ?? [];
    if (managed.includes(cid)) {
      await next();
      return;
    }

    // Occupant: precisa de fração ativa neste condo (mesma regra do ToUnit). Um
    // `core.occupant` sem fração é quem já saiu, e continuava a ler o condomínio.
    const membership = c.get("membership") ??
      await loadUserMembership(postgres, actor.user_id ?? "");
    if (!membership || membership.inCondo(cid).linkedUnitIds.length === 0) {
      throw new HttpError(404, "Condomínio não encontrado");
    }

    await next();
  };
}

/**
 * Auth para `/v1/portal/condominiums/:cid/units/:uid/...`: exige `unit_occupant`
 * ativo na `:uid` (owner ou tenant); super e managers passam se a fração for do condo. O `:uid`
 * vem do path, não pode ser sobreposto via `?unitId=` (vuln do `/admin/...` antigo).
 */
export function requirePortalAccessToUnit(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const role = c.get("role");
    const cid = c.get("condominiumId");
    const actor = c.get("actor");

    if (!cid) throw new HttpError(400, "condominiumId em falta no path");
    if (!actor) throw new HttpError(401, "Sessão obrigatória");

    // `:uid` ainda não populado em `c.req.param` (sub-route não matchou); extrai por regex.
    const unitId = c.req.path.match(/^\/v1\/portal\/condominiums\/[^/]+\/units\/([^/]+)/)?.[1];
    if (!unitId) throw new HttpError(400, "unitId em falta no path");

    const managed = c.get("managedCondominiumIds") ?? [];
    if (role === "super" || managed.includes(cid)) {
      // Cross-tenant guard (também para super): confirma que a unit existe neste condo.
      // Membership não cobre units não-linkadas, daí a query direta.
      const unit = await postgres.query((db) =>
        db.query.unit.findFirst({
          where: (u, ops) =>
            ops.and(
              ops.eq(u.id, unitId),
              ops.eq(u.condominiumId, cid),
              ops.isNull(u.deletedAt),
            ),
          columns: { id: true },
        })
      );
      if (!unit) {
        throw new HttpError(404, "Fração não encontrada");
      }
      await next();
      return;
    }

    // Occupant (owner ou tenant): precisa de unit_occupant ativo nesta unit
    // (`linkedUnitIds` cobre ambos). Membership memoizada em ctx por `apiAuth`.
    const membership = c.get("membership") ??
      await loadUserMembership(postgres, actor.user_id ?? "");
    const linked = !!membership && membership.inCondo(cid).linkedUnitIds.includes(unitId);
    if (!linked) {
      throw new HttpError(404, "Fração não encontrada");
    }

    await next();
  };
}
