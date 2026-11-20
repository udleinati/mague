// GET /v1/auth/invite/:token  - devolve info do user para o form (sem auth)
// POST /v1/auth/accept-invite { token, password } - define password e
//                                                    devolve sessão (sem auth)

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { eq, sql } from "drizzle-orm";
import bcrypt from "npm:bcryptjs@2.4.3";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { env } from "$config/env.ts";
import { createSession } from "$api/libs/session/store.ts";
import { signSessionToken } from "$api/libs/session/jwt.ts";
import { formatAuthSessionForResponse } from "./_projection.ts";
import { isTokenValid } from "./_token.ts";
import { accountReachableOutside, loadUserMembership } from "$api/libs/membership/mod.ts";

/** GET /v1/auth/invite/:token - preview do convite. Devolve user info. */
export const previewInvite = async (ctx: Context, postgres: Postgres) => {
  const token = ctx.req.param("token") ?? "";
  if (!token) {
    throw new AppError({
      message: "Token em falta",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const tokenRow = await postgres.query((db) =>
    db.query.inviteToken.findFirst({
      where: (t, ops) => ops.eq(t.token, token),
    })
  );
  if (!tokenRow || !isTokenValid(tokenRow)) {
    throw new AppError({
      message: "Convite inválido ou expirado",
      statusCode: STATUS_CODE.Gone,
      code: "INVALID_TOKEN",
    });
  }

  const userRow = await postgres.query((db) =>
    db.query.user.findFirst({ where: (u, ops) => ops.eq(u.id, tokenRow.userId) })
  );
  if (!userRow) {
    throw new AppError({
      message: "Utilizador associado ao convite não existe",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  return ctx.json({
    data: {
      purpose: tokenRow.purpose,
      user: {
        name: userRow.name,
        email: userRow.email,
      },
      expiresAt: tokenRow.expiresAt.toISOString(),
    },
  });
};

/** POST /v1/auth/accept-invite - define password, marca token usado, sessão. */
export const acceptInvite = async (ctx: Context, postgres: Postgres) => {
  const body = await ctx.req.json().catch(() => ({}));
  const token = String(body?.token ?? "").trim();
  const password = String(body?.password ?? "");

  if (!token || password.length < 8) {
    throw new AppError({
      message: "Token e password (mín. 8 caracteres) são obrigatórios",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  // Tokens de reset só abrem em /reset-password.
  const tokenRow = await postgres.query((db) =>
    db.query.inviteToken.findFirst({
      where: (t, ops) => ops.and(ops.eq(t.token, token), ops.eq(t.purpose, "invite")),
    })
  );
  if (!tokenRow || !isTokenValid(tokenRow)) {
    throw new AppError({
      message: "Convite inválido ou expirado",
      statusCode: STATUS_CODE.Gone,
      code: "INVALID_TOKEN",
    });
  }

  // Sem `includeInactive`: conta inativa ou apagada não se reativa por convite (ADR 0020).
  const membership = await loadUserMembership(postgres, tokenRow.userId);
  if (!membership) {
    throw new AppError({
      message: "Conta inativa: contacta a administração.",
      statusCode: STATUS_CODE.Conflict,
      code: "USER_INACTIVE",
    });
  }

  // O link fica no email_log/BCC do condomínio: se desde o envio a conta passou
  // a abrir condomínios fora do âmbito de quem convidou, o aceite já não serve.
  const scope = tokenRow.scopeCondominiumIds;
  if (scope && (membership.isSuper || accountReachableOutside(membership, scope))) {
    throw new AppError({
      message: "Este convite já não é válido para esta conta. Pede um novo à administração.",
      statusCode: STATUS_CODE.Forbidden,
      code: "FORBIDDEN",
    });
  }

  // Atomic: hash password + update user + mark token used.
  const hash = await bcrypt.hash(password, 10);
  const user = await postgres.query((db) =>
    db.transaction(async (tx) => {
      // Aceitar conta como first/last login. `firstLoginAt` write-once via
      // COALESCE: re-emitir convite a user ativo preserva o original.
      await tx.update(schema.user)
        .set({
          passwordHash: hash,
          passwordChangedAt: new Date(),
          firstLoginAt: sql`COALESCE(${schema.user.firstLoginAt}, NOW())`,
          lastLoginAt: sql`NOW()`,
          updatedAt: new Date(),
        })
        .where(eq(schema.user.id, tokenRow.userId));
      await tx.update(schema.inviteToken)
        .set({ usedAt: new Date() })
        .where(eq(schema.inviteToken.token, tokenRow.token));
      const [user] = await tx.select().from(schema.user).where(eq(schema.user.id, tokenRow.userId));
      return user;
    })
  );

  // Cria sessão diretamente - o user fica logado após aceitar o convite.
  // ADR 0020: Valkey TTL = idle (sliding); JWT exp = cap absoluto.
  const idleSeconds = env.sessionIdleHours * 3600;
  const jwtExpirySeconds = env.sessionExpiryDays * 86400;
  const session = await createSession({
    userId: user.id,
    ttlSeconds: idleSeconds,
    userAgent: ctx.req.header("user-agent") ?? null,
    ip: ctx.req.header("x-forwarded-for") ?? null,
  });
  const jwt = await signSessionToken(session.id, jwtExpirySeconds);

  return ctx.json({ data: formatAuthSessionForResponse(session, user, jwt) });
};
