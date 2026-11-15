import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { emailLog } from "$api/libs/postgres/schemas/_audit.ts";
import { and, desc, eq } from "drizzle-orm";

// Tecto de segurança: o audit da fração é dump completo (sem paginação), mas
// nunca devolve mais que isto.
const EMAIL_LOG_LIMIT = 500;

export const listUnitEmails = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const unitId = ctx.req.param("unitId");

  if (!unitId) {
    throw new AppError({
      message: "ID da fração inválido",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }

  // Display: lista + corpo do email + nomes dos anexos. NUNCA actor/bcc -
  // auditoria interna. Tenant scope explícito mesmo com unit_id (defesa em
  // profundidade). `id` em string (bigint não serializa em JSON).
  const rows = await postgres.query((db) =>
    db.select({
      id: emailLog.id,
      createdAt: emailLog.createdAt,
      subject: emailLog.subject,
      recipient: emailLog.recipient,
      status: emailLog.status,
      error: emailLog.error,
      bodyHtml: emailLog.bodyHtml,
      attachments: emailLog.attachments,
    })
      .from(emailLog)
      .where(and(
        eq(emailLog.unitId, unitId),
        eq(emailLog.condominiumId, condominiumId),
      ))
      .orderBy(desc(emailLog.createdAt), desc(emailLog.id))
      .limit(EMAIL_LOG_LIMIT)
  );

  return ctx.json({ data: rows.map((r) => ({ ...r, id: String(r.id) })) });
};
