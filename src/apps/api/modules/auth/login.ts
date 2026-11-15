import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import bcrypt from "npm:bcryptjs@2.4.3";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { env } from "$config/env.ts";
import { createSession } from "$api/libs/session/store.ts";
import { signSessionToken } from "$api/libs/session/jwt.ts";
import { formatAuthSessionForResponse } from "./_projection.ts";
import { findActiveUsersByNif } from "./_accounts_by_nif.ts";
import {
  checkLoginRateLimit,
  clearLoginAttempts,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_SECONDS,
  recordFailedAttempt,
} from "$api/libs/rate_limit/login.ts";

// POST /v1/auth/login { identifier, password } → cria sessão no Valkey.
// `identifier` aceita email OU NIF (detecção por `@`); `email` por back-compat.
// Side effects: rate limit Valkey (5/5min → 429); OK zera counter + tracking
// nos occupants; FAIL incr Valkey + `core.user.failed_login_attempts` (lifetime).
export const login = async (ctx: Context, postgres: Postgres) => {
  const body = await ctx.req.json().catch(() => ({}));
  const rawIdentifier = String(body?.identifier ?? body?.email ?? "").trim();
  const password = String(body?.password ?? "");

  if (!rawIdentifier || !password) {
    throw new AppError({
      message: "Identificador (email ou NIF) e password são obrigatórios",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const isEmail = rawIdentifier.includes("@");
  const identifier = isEmail ? rawIdentifier.toLowerCase() : rawIdentifier;

  // IP para os counters de rate limit. Caddy preenche x-forwarded-for em prod;
  // dev pode vir null (fallback "_unknown_" no lib).
  const ip = ctx.req.header("x-forwarded-for")?.split(",")[0].trim() ?? null;

  // Rate limit ANTES de tocar na DB - não vaza info se identifier existe.
  const rl = await checkLoginRateLimit(identifier, ip);
  if (rl.blocked) {
    throw new AppError({
      message: `Demasiadas tentativas. Aguarda ${Math.ceil(rl.retryAfterSeconds / 60)} min.`,
      statusCode: STATUS_CODE.TooManyRequests,
      code: "RATE_LIMITED",
    });
  }

  // NIF vive em core.occupant - login por NIF resolve via
  // occupant → user_id (qualquer condo serve); email vai direto ao core.user.
  let candidates: (typeof schema.user.$inferSelect)[];
  if (isEmail) {
    const byEmail = await postgres.query((db) =>
      db.query.user.findFirst({
        where: (u, o) =>
          o.and(
            o.eq(u.email, identifier),
            o.eq(u.isActive, true),
            o.isNull(u.deletedAt),
          ),
      })
    );
    candidates = byEmail ? [byEmail] : [];
  } else {
    candidates = await findActiveUsersByNif(postgres, identifier);
  }

  // Falha com tracking. Mensagem genérica: não vaza user inexistente vs password errada.
  const failLogin = async (userIds: string[]) => {
    const { idIpAttempts } = await recordFailedAttempt(identifier, ip);
    // Counter lifetime na DB; só se o user existe (não criamos rows fantasma).
    if (userIds.length > 0) {
      await postgres.query((db) =>
        db.update(schema.user)
          .set({
            failedLoginAttempts: sql`${schema.user.failedLoginAttempts} + 1`,
            lastFailedLoginAt: new Date(),
          })
          .where(and(inArray(schema.user.id, userIds), isNull(schema.user.deletedAt)))
      );
    }
    const code = idIpAttempts > RATE_LIMIT_MAX ? "RATE_LIMITED" : "INVALID_CREDENTIALS";
    const message = idIpAttempts > RATE_LIMIT_MAX
      ? `Demasiadas tentativas. Aguarda ${Math.ceil(RATE_LIMIT_WINDOW_SECONDS / 60)} min.`
      : "Credenciais inválidas";
    const status = idIpAttempts > RATE_LIMIT_MAX
      ? STATUS_CODE.TooManyRequests
      : STATUS_CODE.Unauthorized;
    throw new AppError({ message, statusCode: status, code });
  };

  // Com o mesmo NIF em várias contas, entra a conta cuja password bate.
  let user: (typeof schema.user.$inferSelect) | undefined;
  for (const candidate of candidates) {
    if (candidate.passwordHash && await bcrypt.compare(password, candidate.passwordHash)) {
      user = candidate;
      break;
    }
  }
  if (!user) return await failLogin(candidates.map((c) => c.id));

  // ─── Sucesso ───────────────────────────────────────────────────────
  // (`ip` já capturado no topo para uso no rate limit)
  const userAgent = ctx.req.header("user-agent") ?? null;

  // Limpa só o counter (identifier, ip); o counter global por IP decai por
  // timeout (atacante não recupera budget ao acertar na própria conta).
  await clearLoginAttempts(identifier, ip);

  // Tracking nos occupants do user (no-op para admin/super sem occupants).
  await postgres.query((db) =>
    db.update(schema.occupant)
      .set({
        // `firstLoginAt` write-once via COALESCE; `NOW()` SQL evita weirdness
        // de timezone que a serialização de JS Date causa no COALESCE.
        firstLoginAt: sql`COALESCE(${schema.occupant.firstLoginAt}, NOW())`,
        lastLoginAt: sql`NOW()`,
        // Coluna `inet` em PG mas `text` em Drizzle: cast text→inet explícito.
        lastLoginIp: ip ? sql`${ip}::inet` : null,
        lastLoginUserAgent: userAgent,
        updatedAt: sql`NOW()`,
      })
      .where(and(
        eq(schema.occupant.userId, user.id),
        isNull(schema.occupant.deletedAt),
      ))
  );

  // Tracking ao nível do user (vale para super/admin sem occupant).
  // `firstLoginAt` write-once via COALESCE.
  await postgres.query((db) =>
    db.update(schema.user)
      .set({
        lastLoginAt: sql`NOW()`,
        firstLoginAt: sql`COALESCE(${schema.user.firstLoginAt}, NOW())`,
        updatedAt: sql`NOW()`,
      })
      .where(eq(schema.user.id, user.id))
  );

  // ADR 0020: Valkey TTL = idle sliding; JWT exp = cap absoluto.
  const idleSeconds = env.sessionIdleHours * 3600;
  const jwtExpirySeconds = env.sessionExpiryDays * 86400;
  const session = await createSession({
    userId: user.id,
    ttlSeconds: idleSeconds,
    userAgent,
    ip,
  });
  const token = await signSessionToken(session.id, jwtExpirySeconds);

  return ctx.json({ data: formatAuthSessionForResponse(session, user, token) });
};
