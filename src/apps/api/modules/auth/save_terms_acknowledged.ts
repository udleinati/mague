// POST /v1/auth/me/terms-acknowledged - regista aceitação do aviso de privacidade.
// Write-once via COALESCE: a 1ª aceitação nunca é re-escrita (idempotente).

import type { Context } from "hono";
import { eq, sql } from "drizzle-orm";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { getSession, refreshSessionTtl } from "$api/libs/session/store.ts";
import { extractSidFromBearer } from "$api/libs/session/jwt.ts";
import { env } from "$config/env.ts";

export const saveTermsAcknowledged = async (ctx: Context, postgres: Postgres) => {
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

  const updated = await postgres.query((db) =>
    db.update(schema.user)
      .set({
        termsAcknowledgedAt: sql`COALESCE(${schema.user.termsAcknowledgedAt}, NOW())`,
        updatedAt: new Date(),
      })
      .where(eq(schema.user.id, s.userId))
      .returning({ termsAcknowledgedAt: schema.user.termsAcknowledgedAt })
  );

  return ctx.json({
    data: { acknowledgedAt: updated[0]?.termsAcknowledgedAt?.toISOString() ?? null },
  });
};
