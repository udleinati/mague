// POST /v1/auth/forgot-password { identifier } - email ou NIF; sempre 204
//   (não vaza existência); envia link de reset (TTL 1h) se houver email.
// POST /v1/auth/reset-password { token, password } - valida e cria sessão
//   imediata (mesmo flow que accept-invite).

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { and, eq, isNull, sql } from "drizzle-orm";
import bcrypt from "npm:bcryptjs@2.4.3";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { env } from "$config/env.ts";
import { resetPasswordEmailHtml, sendEmail } from "$api/libs/email/send.ts";
import { createSession } from "$api/libs/session/store.ts";
import { signSessionToken } from "$api/libs/session/jwt.ts";
import { formatAuthSessionForResponse } from "./_projection.ts";
import type { UserSelect } from "$api/libs/postgres/schemas/user.ts";
import { generateAuthToken, isTokenValid, TOKEN_TTL, TOKEN_TTL_LABEL } from "./_token.ts";
import { findActiveUsersByNif } from "./_accounts_by_nif.ts";

export const forgotPassword = async (ctx: Context, postgres: Postgres) => {
  const body = await ctx.req.json().catch(() => ({}));
  const identifier = String(body?.identifier ?? "").trim();
  if (!identifier) {
    // 204 mesmo sem identifier - não desperdiçar info ao atacante.
    return new Response(null, { status: STATUS_CODE.NoContent });
  }

  // NIF vive em core.occupant - reset por NIF resolve
  // via occupant → user_id; email vai direto.
  const isEmail = identifier.includes("@");
  let users: UserSelect[];
  try {
    if (isEmail) {
      const byEmail = await postgres.query((db) =>
        db.query.user.findFirst({
          where: (u, ops) =>
            ops.and(
              ops.eq(u.email, identifier.toLowerCase()),
              ops.eq(u.isActive, true),
              ops.isNull(u.deletedAt),
            ),
        })
      );
      users = byEmail ? [byEmail] : [];
    } else {
      users = await findActiveUsersByNif(postgres, identifier);
    }
  } catch (e) {
    // Mesmo em erro do DB, devolve 204 para o user. Loga o erro.
    console.error("[forgotPassword] DB error:", e);
    return new Response(null, { status: STATUS_CODE.NoContent });
  }

  // NIF em várias contas: cada link vai para o email da própria conta.
  for (const user of users) {
    // Sem email → nada a enviar.
    if (user.email) await sendResetLink(ctx, postgres, user);
  }

  return new Response(null, { status: STATUS_CODE.NoContent });
};

async function sendResetLink(ctx: Context, postgres: Postgres, user: UserSelect) {
  // Invalida tokens de reset anteriores deste user.
  try {
    await postgres.query((db) =>
      db.update(schema.inviteToken)
        .set({ usedAt: new Date() })
        .where(and(
          eq(schema.inviteToken.userId, user.id),
          eq(schema.inviteToken.purpose, "reset"),
          isNull(schema.inviteToken.usedAt),
        ))
    );
  } catch (e) {
    console.error("[forgotPassword] invalidate prev:", e);
  }

  const token = generateAuthToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL.reset * 1000);
  try {
    await postgres.query((db) =>
      db.insert(schema.inviteToken).values({
        token,
        userId: user.id,
        purpose: "reset",
        // Forgot-password é fluxo público - sem actor logado.
        createdBy: {},
        expiresAt,
      })
    );
  } catch (e) {
    console.error("[forgotPassword] insert token:", e);
    return;
  }

  // `safePanelBaseUrl` valida o header contra a allowlist: sem isto, atacante
  // podia disparar o link de reset para um domínio próprio (`https://evil.com`).
  const { safePanelBaseUrl } = await import("$api/libs/shared/panel_base_url.ts");
  const baseUrl = safePanelBaseUrl(ctx);
  const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
  try {
    await sendEmail({
      to: user.email!,
      subject: "Reset de password - MAGUE",
      // password_reset: nunca logado em audit.email_log + ignora BCC do condo.
      category: "password_reset",
      html: resetPasswordEmailHtml({
        userName: user.name ?? user.email ?? "Utilizador",
        resetUrl,
        ttl: TOKEN_TTL_LABEL.reset,
      }),
    });
  } catch (e) {
    console.error("[forgotPassword] send email:", e);
    // Continua silenciosamente - não vazar.
  }
}

export const resetPassword = async (ctx: Context, postgres: Postgres) => {
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

  const tokenRow = await postgres.query((db) =>
    db.query.inviteToken.findFirst({
      where: (t, ops) =>
        ops.and(
          ops.eq(t.token, token),
          ops.eq(t.purpose, "reset"),
        ),
    })
  );
  if (!tokenRow || !isTokenValid(tokenRow)) {
    throw new AppError({
      message: "Token inválido ou expirado",
      statusCode: STATUS_CODE.Gone,
      code: "INVALID_TOKEN",
    });
  }

  const hash = await bcrypt.hash(password, 10);
  const userAgent = ctx.req.header("user-agent") ?? null;
  const ip = ctx.req.header("x-forwarded-for")?.split(",")[0].trim() ?? null;
  const user = await postgres.query((db) =>
    db.transaction(async (tx) => {
      // Reset cria sessão imediata - é o primeiro acesso. Regista tracking
      // como o login.ts; `firstLoginAt` write-once via COALESCE.
      await tx.update(schema.user)
        .set({
          passwordHash: hash,
          passwordChangedAt: new Date(),
          firstLoginAt: sql`COALESCE(${schema.user.firstLoginAt}, NOW())`,
          lastLoginAt: sql`NOW()`,
          updatedAt: new Date(),
        })
        .where(eq(schema.user.id, tokenRow.userId));
      // Tracking nos occupants do user (no-op se não tiver) - igual ao login.ts.
      await tx.update(schema.occupant)
        .set({
          firstLoginAt: sql`COALESCE(${schema.occupant.firstLoginAt}, NOW())`,
          lastLoginAt: sql`NOW()`,
          lastLoginIp: ip ? sql`${ip}::inet` : null,
          lastLoginUserAgent: userAgent,
          updatedAt: sql`NOW()`,
        })
        .where(and(
          eq(schema.occupant.userId, tokenRow.userId),
          isNull(schema.occupant.deletedAt),
        ));
      await tx.update(schema.inviteToken)
        .set({ usedAt: new Date() })
        .where(eq(schema.inviteToken.token, tokenRow.token));
      const [user] = await tx.select().from(schema.user).where(eq(schema.user.id, tokenRow.userId));
      return user;
    })
  );

  // ADR 0020: Valkey TTL = idle (sliding); JWT exp = cap absoluto.
  const idleSeconds = env.sessionIdleHours * 3600;
  const jwtExpirySeconds = env.sessionExpiryDays * 86400;
  const session = await createSession({
    userId: user.id,
    ttlSeconds: idleSeconds,
    userAgent,
    ip,
  });
  const jwt = await signSessionToken(session.id, jwtExpirySeconds);

  return ctx.json({ data: formatAuthSessionForResponse(session, user, jwt) });
};
