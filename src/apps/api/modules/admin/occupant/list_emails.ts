import type { Context } from "hono";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { requireParam } from "$api/libs/shared/require_param.ts";
import { emailLog } from "$api/libs/postgres/schemas/_audit.ts";
import { and, desc, eq } from "drizzle-orm";

// Tecto de segurança (sem paginação - dump completo, mesmo critério da fração).
const EMAIL_LOG_LIMIT = 500;

export const listOccupantEmails = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const occupantId = requireParam(ctx, "occupantId");

  // Chave estável `occupant_id` (vs `recipient` string). Tenant scope explícito
  // por condominium_id: occupant de outro condo devolve vazio (anti-leak).
  // Display: lista + corpo + nomes dos anexos. NUNCA actor/bcc. `id` em string
  // (bigint não serializa em JSON).
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
        eq(emailLog.occupantId, occupantId),
        eq(emailLog.condominiumId, condominiumId),
      ))
      .orderBy(desc(emailLog.createdAt), desc(emailLog.id))
      .limit(EMAIL_LOG_LIMIT)
  );

  return ctx.json({ data: rows.map((r) => ({ ...r, id: String(r.id) })) });
};
