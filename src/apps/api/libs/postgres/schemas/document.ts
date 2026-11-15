import { boolean, date, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

export const DOCUMENT_CATEGORIES = [
  "minutes",
  "regulation",
  "contract",
  "budget",
  "insurance",
  "plant",
  "other",
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

// ═══ document ═══════════════════════════════════════════════════════════════
// Ficheiros via core.attachment (entity_type='document').
export const document = schema.table("document", {
  id: text("id").default(sql`public.nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),

  title: text("title").notNull(),
  description: text("description"),

  category: varchar("category", { length: 20 }).default("other").notNull(),

  // true = visível ao condómino no portal; false = só admin.
  isPublic: boolean("is_public").default(false).notNull(),

  // Data oficial do documento (assembleia/assinatura). NULLABLE - regulamento
  // ou plantas não têm.
  publishedAt: date("published_at"),

  createdBy: actorColumn("created_by").notNull(),
  updatedBy: actorColumn("updated_by"),
  deletedBy: actorColumn("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type DocumentSelect = typeof document.$inferSelect;
export type DocumentInsert = typeof document.$inferInsert;
