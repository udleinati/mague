// POST .../save-occupant-profile { name, email, phone, receiveReceiptEmails } -
// condómino atualiza os SEUS dados (NIF tem fluxo dedicado write-once). Anti-IDOR:
// resolve o occupant via user_id da sessão + unit, nunca aceita `occupantId` do body.

import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { getSession } from "$api/libs/session/store.ts";
import { extractSidFromBearer } from "$api/libs/session/jwt.ts";
import { sql } from "drizzle-orm";

export const saveOccupantProfile = async (ctx: Context, postgres: Postgres) => {
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
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const emailRaw = typeof body?.email === "string" ? body.email.trim() : "";
  const phoneRaw = typeof body?.phone === "string" ? body.phone.trim() : "";
  const receiveReceiptEmails = body?.receiveReceiptEmails === true ||
    body?.receiveReceiptEmails === "true" || body?.receiveReceiptEmails === "1" ||
    body?.receiveReceiptEmails === "on";

  if (!name) {
    throw new AppError({
      message: "Nome é obrigatório",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }
  if (name.length > 255) {
    throw new AppError({
      message: "Nome demasiado longo (máx. 255)",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }
  // Email: vazio (clears) ou contém "@" (validação leve; confia no input type=email).
  if (emailRaw && (!emailRaw.includes("@") || emailRaw.length > 255)) {
    throw new AppError({
      message: "Email inválido",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }
  if (phoneRaw.length > 30) {
    throw new AppError({
      message: "Telefone demasiado longo (máx. 30)",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  // Resolve o occupant do user nesta unit.
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
      .set({
        name,
        email: emailRaw || null,
        phone: phoneRaw || null,
        receiveReceiptEmails,
        updatedAt: new Date(),
      })
      .where(eq(schema.occupant.id, occ.id))
  );

  // Sincroniza só `core.user.name` (display do header via auth.me); email/phone
  // ficam no occupant (per-condomínio). Sem isto o header mostra o nome antigo até logout.
  await postgres.query((db) =>
    db.update(schema.user)
      .set({ name, updatedAt: new Date() })
      .where(eq(schema.user.id, s.userId))
  );

  return ctx.json({
    data: {
      occupantId: occ.id,
      name,
      email: emailRaw || null,
      phone: phoneRaw || null,
      receiveReceiptEmails,
    },
  });
};
