// POST .../save-receive-receipts { receiveReceiptEmails } - toggle inline da
// preferência de recibos por email. Endpoint dedicado (não partilha com
// save-occupant-profile, que exige `name`): toggle on-change sem reenviar o perfil.

import type { Context } from "hono";
import { eq, sql } from "drizzle-orm";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { getSession } from "$api/libs/session/store.ts";
import { extractSidFromBearer } from "$api/libs/session/jwt.ts";

export const saveReceiveReceipts = async (ctx: Context, postgres: Postgres) => {
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

  const condominiumId = ctx.req.param("cid");
  const unitId = ctx.req.param("unitId");
  if (!condominiumId || !unitId) {
    throw new AppError({
      message: "cid + unitId obrigatórios",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  const body = await ctx.req.json().catch(() => ({}));
  const receiveReceiptEmails = body?.receiveReceiptEmails === true ||
    body?.receiveReceiptEmails === "true" || body?.receiveReceiptEmails === "1" ||
    body?.receiveReceiptEmails === "on";

  // Resolve o occupant via user_id da sessão (anti-IDOR: ignora `occupantId` do body).
  const occupantRows = await postgres.query((db) =>
    db.execute<{ id: string }>(sql`
      SELECT o.id
        FROM core.occupant o
        JOIN core.unit_occupant uo ON uo.occupant_id = o.id
       WHERE o.user_id = ${s.userId}
         AND o.condominium_id = ${condominiumId}
         AND o.deleted_at IS NULL
         AND uo.unit_id = ${unitId}
         AND uo.deleted_at IS NULL
         AND uo.end_date IS NULL
       LIMIT 1
    `)
  );
  const occ = occupantRows[0];
  if (!occ) {
    throw new AppError({
      message: "Occupant não encontrado para este user nesta fração",
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }

  await postgres.query((db) =>
    db.update(schema.occupant)
      .set({ receiveReceiptEmails, updatedAt: new Date() })
      .where(eq(schema.occupant.id, occ.id))
  );

  return ctx.json({
    data: { occupantId: occ.id, receiveReceiptEmails },
  });
};
