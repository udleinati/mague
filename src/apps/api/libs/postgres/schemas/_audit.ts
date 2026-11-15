import { bigint, jsonb, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * Snapshot do actor em `created_by`/`updated_by`/`deleted_by` e nos logs de
 * audit (ADR 0011). Campos individualmente opcionais; `{}` é válido (ops sem
 * user: migrations/jobs). Sem FK a `core.user` - sobrevive a soft-delete.
 */
export interface ActorSnapshot {
  user_id?: string;
  email?: string | null;
  ip?: string | null;
  user_agent?: string | null;
  request_id?: string | null;
}

/**
 * Actor garantidamente derivado de uma request HTTP autenticada.
 * Devolvido por `requireActor(ctx)` - `user_id` é sempre presente porque
 * o helper lança 401 se não houver user logado.
 */
export interface RealActorSnapshot extends ActorSnapshot {
  user_id: string;
}

export const actorColumn = (name: string) => jsonb(name).$type<ActorSnapshot>();

// ─── audit.log ───────────────────────────────────────────────────────────────
// Append-only. Particionada por ano em created_at; PK real é (id, created_at).
// Aqui id é PK simbólico - Drizzle não precisa da composta para SELECT.

const auditSchema = pgSchema("audit");

// ─── audit.email_log ─────────────────────────────────────────────────────
// Metadados de cada email enviado pela aplicação + o corpo HTML
// e os nomes dos anexos (NÃO o conteúdo dos anexos). actor/bcc são internos e
// nunca expostos na API. Reset de password não é logado (categoria
// 'password_reset' bypassa o INSERT).

/** Nome + tipo de cada anexo enviado. Sem o conteúdo (só indicação). */
export interface EmailAttachmentMeta {
  filename: string;
  contentType?: string | null;
}

export const emailLog = auditSchema.table("email_log", {
  id: bigint("id", { mode: "bigint" }).generatedAlwaysAsIdentity(),
  category: varchar("category", { length: 40 }).notNull(),
  recipient: text("recipient").notNull(),
  bcc: text("bcc"),
  subject: text("subject").notNull(),
  condominiumId: text("condominium_id"),
  unitId: text("unit_id"),
  // Chave estável do destinatário (vs `recipient` string mutável)
  // para o audit por ocupante. Populado nos call sites; NULL em linhas antigas.
  occupantId: text("occupant_id"),
  actor: jsonb("actor").$type<ActorSnapshot>(),
  status: varchar("status", { length: 20 }).notNull().default("sent"),
  error: text("error"),
  // Corpo HTML enviado + nomes dos anexos. NULL em linhas antigas.
  bodyHtml: text("body_html"),
  attachments: jsonb("attachments").$type<EmailAttachmentMeta[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
