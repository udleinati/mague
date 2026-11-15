import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import bcrypt from "npm:bcryptjs@2.4.3";
import { eq } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { getSession, refreshSessionTtl } from "$api/libs/session/store.ts";
import { extractSidFromBearer } from "$api/libs/session/jwt.ts";
import { env } from "$config/env.ts";

// POST /v1/auth/change-password { currentPassword, newPassword } - 204.
export const changePassword = async (ctx: Context, postgres: Postgres) => {
  const sessionId = await extractSidFromBearer(ctx.req.header("authorization"));
  if (!sessionId) {
    throw new AppError({
      message: "sessão em falta",
      statusCode: STATUS_CODE.Unauthorized,
      code: "NO_SESSION",
    });
  }

  const s = await getSession(sessionId);
  if (!s) {
    throw new AppError({
      message: "sessão inválida ou expirada",
      statusCode: STATUS_CODE.Unauthorized,
      code: "INVALID_SESSION",
    });
  }

  // Sliding TTL (ADR 0020) - este endpoint está em /v1/auth/* (pré-middleware).
  await refreshSessionTtl(sessionId, env.sessionIdleHours * 3600);

  const body = await ctx.req.json().catch(() => ({}));
  const currentPassword = String(body?.currentPassword ?? "");
  const newPassword = String(body?.newPassword ?? "");

  if (!currentPassword || !newPassword) {
    throw new AppError({
      message: "Senha atual e nova são obrigatórias",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  if (newPassword.length < 8) {
    throw new AppError({
      message: "Nova senha tem de ter pelo menos 8 caracteres",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  if (currentPassword === newPassword) {
    throw new AppError({
      message: "Nova senha tem de ser diferente da atual",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const user = await postgres.query((db) =>
    db.query.user.findFirst({ where: (u, o) => o.eq(u.id, s.userId) })
  );
  if (!user || !user.passwordHash) {
    throw new AppError({
      message: "Utilizador não encontrado",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  const match = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!match) {
    throw new AppError({
      message: "Senha atual incorreta",
      statusCode: STATUS_CODE.Unauthorized,
      code: "INVALID_PASSWORD",
    });
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  await postgres.query((db) =>
    db.update(schema.user)
      .set({ passwordHash: newHash, passwordChangedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.user.id, s.userId))
      .returning()
  );

  return new Response(null, { status: STATUS_CODE.NoContent });
};
