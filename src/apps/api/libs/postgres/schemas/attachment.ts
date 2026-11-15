// Schema unificado de attachments.
// Substitui charge_attachment, ticket_attachment, inspection_attachment.
// Permite anexar a charge, ticket, inspection, assembly, insurance.

import { sql } from "drizzle-orm";
import { check, integer, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { actorColumn } from "./_audit.ts";

const core = pgSchema("core");

export const ATTACHMENT_ENTITY_TYPES = [
  "charge",
  "ticket",
  "inspection",
  "assembly",
  "insurance",
  "document",
  "pathology",
] as const;
export type AttachmentEntityType = (typeof ATTACHMENT_ENTITY_TYPES)[number];

export const attachment = core.table("attachment", {
  id: text("id").default(sql`public.nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),
  /** Discriminator polimórfico - define qual tipo de pai é referenciado. */
  entityType: varchar("entity_type", { length: 30 }).notNull().$type<AttachmentEntityType>(),
  /** ID do pai (charge.id | ticket.id | inspection.id | assembly.id | insurance_policy.id). */
  entityId: text("entity_id").notNull(),

  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  /** Storage key absoluto no S3. Formato atual:
   *  `<cid>/<entity>/<shard>/<parent_id>/<attachment_id>-<filename>`. */
  storageKey: text("storage_key").notNull().unique(),
  storageEtag: text("storage_etag"),
  fileSize: integer("file_size").notNull(),
  fileSha256: text("file_sha256"),

  // Audit + soft-delete (ADR 0011 - actor cols typed via actorColumn helper).
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
  deletedBy: actorColumn("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (t) => ({
  entityCheck: check(
    "attachment_entity_type_check",
    sql`${t.entityType} IN ('charge', 'ticket', 'inspection', 'assembly', 'insurance', 'document', 'pathology')`,
  ),
}));

export type AttachmentSelect = typeof attachment.$inferSelect;
export type AttachmentInsert = typeof attachment.$inferInsert;
