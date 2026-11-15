// POST /v1/auth/me/theme  body: { theme: 'light' | 'dark' | null }
//
// Persiste a preferência de tema do user logado em `core.user.theme`.
// Não toca em nada mais (cookie no browser fica como cache local). Idempotente.

import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { getSession, refreshSessionTtl } from "$api/libs/session/store.ts";
import { extractSidFromBearer } from "$api/libs/session/jwt.ts";
import { env } from "$config/env.ts";

const VALID = new Set([null, "light", "dark"]);

export const saveTheme = async (ctx: Context, postgres: Postgres) => {
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
  const raw = body?.theme;
  const theme = (raw === "light" || raw === "dark") ? raw : null;
  if (!VALID.has(theme)) {
    throw new AppError({
      message: "theme deve ser 'light', 'dark' ou null",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  await postgres.query((db) =>
    db.update(schema.user).set({ theme, updatedAt: new Date() }).where(eq(schema.user.id, s.userId))
  );

  return ctx.json({ data: { theme } });
};
