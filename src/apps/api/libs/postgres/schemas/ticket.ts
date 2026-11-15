import { boolean, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

// Enums espelhados como `as const` para uso em Zod (ver libs/model/ticket.ts).
export const TICKET_CATEGORIES = [
  "elevator",
  "lighting",
  "plumbing",
  "hvac",
  "common_area",
  "facade",
  "parking",
  "garden",
  "security",
  "cleaning",
  "other",
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

// Visibilidade no portal, em três níveis (um booleano `is_public` seria ambíguo):
//   - admin_only: só administração.
//   - admin_unit: administração + ocupantes da fração (CHECK exige unit_id NOT NULL).
//   - public:     todos os condóminos.
export const TICKET_VISIBILITIES = ["admin_only", "admin_unit", "public"] as const;
// ═══ ticket ═══════════════════════════════════════════════════════════════
export const ticket = schema.table("ticket", {
  id: text("id").default(sql`public.nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),

  // Code humano per-condomínio (ADR 0023), atribuído pelo trigger (component
  // 018). Sem `.notNull()` no Drizzle de propósito: o trigger preenche, logo
  // `$inferInsert` não o deve exigir (igual a pathology/inspection.code).
  code: varchar("code", { length: 10 }),

  title: text("title").notNull(),
  description: text("description"),

  category: varchar("category", { length: 30 }).notNull(),
  priority: varchar("priority", { length: 10 }).default("normal").notNull(),
  status: varchar("status", { length: 20 }).default("open").notNull(),

  unitId: text("unit_id"),
  location: text("location"),

  // Ocupante que reportou pelo portal. Destinatário dos emails
  // de interação; NULL nas ocorrências criadas pelo admin.
  reportedByOccupantId: text("reported_by_occupant_id"),

  // FK opcional para core.pathology (ADR 0024). ON DELETE
  // SET NULL: se a patologia for eliminada, o ticket sobrevive sem associação.
  pathologyId: text("pathology_id"),

  // Ver TICKET_VISIBILITIES acima. Só admin altera via patch.
  visibility: varchar("visibility", { length: 20 }).default("admin_only").notNull(),

  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolutionNotes: text("resolution_notes"),

  createdBy: actorColumn("created_by").notNull(),
  updatedBy: actorColumn("updated_by"),
  deletedBy: actorColumn("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type TicketSelect = typeof ticket.$inferSelect;
export type TicketInsert = typeof ticket.$inferInsert;
export type TicketUpdate = Partial<TicketInsert>;

// ═══ ticket_comment ═══════════════════════════════════════════════════════
export const ticketComment = schema.table("ticket_comment", {
  id: text("id").default(sql`public.nanoid(10)`).primaryKey(),
  ticketId: text("ticket_id").notNull(),
  condominiumId: text("condominium_id").notNull(),

  comment: text("comment").notNull(),
  isInternal: boolean("is_internal").default(false).notNull(),

  // Mudança de estado: preenchido quando o handler de update gera um
  // comment automático. Para um comment "humano" estes ficam null.
  statusFrom: varchar("status_from", { length: 20 }),
  statusTo: varchar("status_to", { length: 20 }),

  createdBy: actorColumn("created_by").notNull(),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
  // ticket_comment é append-only, sem soft-delete.
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type TicketCommentSelect = typeof ticketComment.$inferSelect;
export type TicketCommentInsert = typeof ticketComment.$inferInsert;

// ═══ ticket_attachment (sem tabela própria - anexos vivem em core.attachment)
// Aliases retro mantidos para compat de tipos enquanto refactor consolida.
import type { AttachmentInsert, AttachmentSelect } from "./attachment.ts";
export type TicketAttachmentSelect = AttachmentSelect;
export type TicketAttachmentInsert = AttachmentInsert;
