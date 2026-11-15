import type { Context, MiddlewareHandler } from "hono";
import { HttpError } from "./error.ts";
import { getSession, refreshSessionTtl } from "$api/libs/session/store.ts";
import { extractSidFromBearer } from "$api/libs/session/jwt.ts";
import { postgres } from "$api/libs/postgres/postgres.ts";
import { loadUserMembership, type UserMembership } from "$api/libs/membership/mod.ts";
import { env } from "$config/env.ts";
import type { ActorSnapshot, RealActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";

export interface ApiVariables {
  // Pós-ADR 0002: admin de condomínio específico deriva-se de `managedCondominiumIds`.
  role: "super" | null;
  condominiumId: string | null;
  /** ActorSnapshot canónico (ADR 0011). Use `requireActor(ctx)`. */
  actor: ActorSnapshot | null;
  managedCondominiumIds: string[];
  /** Membership memoizada per-request por `apiAuth` (evita reloads). Null antes de apiAuth correr. */
  membership: UserMembership | null;
}

export type ApiEnv = {
  Variables: ApiVariables;
};

/**
 * Auth da API - apenas `Authorization: Bearer <jwt>` (envelope HS256, ADR 0007).
 * O `cid` vem SEMPRE do path `:cid`, nunca de header. Actor segue ADR 0011.
 */
export function apiAuth(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const auth = c.req.header("authorization") ?? null;
    const sessionId = await extractSidFromBearer(auth);
    if (!sessionId) throw new HttpError(401, "Authorization Bearer em falta ou inválido");

    const s = await getSession(sessionId);
    if (!s) throw new HttpError(401, "Sessão inválida ou expirada");

    const membership = await loadUserMembership(postgres, s.userId);
    if (!membership) throw new HttpError(401, "Utilizador da sessão não encontrado");

    // Sliding TTL (ADR 0020): refresca a sessão a cada request autenticada.
    // Fire-and-forget: se Valkey falhar, a sessão só expira mais cedo.
    await refreshSessionTtl(sessionId, env.sessionIdleHours * 3600);
    const user = membership.user;
    const managed = membership.activeManagerCondoIds;
    const occupantCondos = membership.occupantCondoIds;

    const cid = c.req.path.match(/^\/v1\/(?:admin|portal)\/condominiums\/([^/]+)/)?.[1] ?? null;

    if (cid && user.role !== "super" && !managed.includes(cid) && !occupantCondos.includes(cid)) {
      throw new HttpError(403, "Sem acesso a este condomínio");
    }

    const userIp = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? null;
    const userAgent = c.req.header("user-agent") ?? null;

    // Sempre server-side: ignora `x-request-id` (não confiamos em input externo).
    const requestId = crypto.randomUUID();

    const actor: RealActorSnapshot = {
      user_id: user.id,
      email: user.email ?? null,
      ip: userIp,
      user_agent: userAgent,
      request_id: requestId,
    };

    c.set("role", user.role === "super" ? "super" : null);
    c.set("condominiumId", cid);
    c.set("managedCondominiumIds", managed);
    c.set("actor", actor);
    c.set("membership", membership);

    await next();
  };
}

/**
 * ActorSnapshot da request com `user_id` garantido; lança 401 se ausente
 * (só acontece se `apiAuth` não correu antes). Writes não-API: passa `{}` literal.
 */
export function requireActor(ctx: Context<ApiEnv>): RealActorSnapshot {
  const actor = ctx.get("actor");
  if (!actor || !actor.user_id) {
    throw new HttpError(401, "AUTH_REQUIRED - actor missing");
  }
  return actor as RealActorSnapshot;
}
