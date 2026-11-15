// POST .../save-nif { nif } - persiste o NIF do occupant em `core.occupant.nif`.
// Valida check-digit PT; write-once (409 NIF_LOCKED);
// anti-colisão por condo (409 NIF_TAKEN, sem UNIQUE INDEX: NIF pode repetir-se
// entre condos). Auth via `requirePortalAccessToUnit`.

import type { Context } from "hono";
import { eq, sql } from "drizzle-orm";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { getSession } from "$api/libs/session/store.ts";
import { extractSidFromBearer } from "$api/libs/session/jwt.ts";
import { isValidPortugueseNif } from "$shared/nif.ts";

export const saveOccupantNif = async (ctx: Context, postgres: Postgres) => {
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
  const nif = String(body?.nif ?? "").replace(/\s+/g, "").trim();
  if (!nif) {
    throw new AppError({
      message: "NIF em falta",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }
  if (!isValidPortugueseNif(nif)) {
    throw new AppError({
      message: "NIF inválido - verifica os 9 dígitos",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  // Resolve o occupant via user_id da sessão + condo + unit_occupant ativo nesta unit.
  const occupantRows = await postgres.query((db) =>
    db.execute<{ id: string; nif: string | null }>(sql`
      SELECT o.id, o.nif
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

  // Atomic write-once: SELECT FOR UPDATE → check → UPDATE.
  await postgres.transaction(async (tx) => {
    const [locked] = await tx.execute<{ nif: string | null }>(
      sql`SELECT nif FROM core.occupant WHERE id = ${occ.id} FOR UPDATE`,
    );
    if (locked?.nif) {
      throw new AppError({
        message: "NIF já preenchido - não pode ser alterado",
        statusCode: STATUS_CODE.Conflict,
        code: "NIF_LOCKED",
      });
    }
    // Anti-colisão dentro do mesmo condomínio.
    const collision = await tx.query.occupant.findFirst({
      where: (o, ops) =>
        ops.and(
          ops.eq(o.condominiumId, condominiumId),
          ops.eq(o.nif, nif),
          ops.ne(o.id, occ.id),
          ops.isNull(o.deletedAt),
        ),
    });
    if (collision) {
      throw new AppError({
        message: "Este NIF já está associado a outro ocupante neste condomínio",
        statusCode: STATUS_CODE.Conflict,
        code: "NIF_TAKEN",
      });
    }
    await tx.update(schema.occupant)
      .set({ nif, updatedAt: new Date() })
      .where(eq(schema.occupant.id, occ.id));
  });

  return ctx.json({ data: { nif, occupantId: occ.id } });
};
