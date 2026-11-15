// Schema Drizzle para `core.pathology` + `core.pathology_unit` (N:N a units).
// Ver ADR 0024.

import { boolean, date, pgSchema, primaryKey, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

// Enums espelhados como `as const` para Zod (libs/model/pathology.ts) e UI.
export const PATHOLOGY_CATEGORIES = [
  "crack",
  "infiltration",
  "humidity",
  "efflorescence",
  "detachment",
  "corrosion",
  "mould",
  "structural",
  "other",
] as const;
export type PathologyCategory = (typeof PATHOLOGY_CATEGORIES)[number];

export const PATHOLOGY_STATUSES = [
  "draft",
  "identified",
  "awaiting_quotes",
  "quote_approved",
  "awaiting_repair_start",
  "in_repair",
  "resolved",
  "dismissed",
] as const;
export type PathologyStatus = (typeof PATHOLOGY_STATUSES)[number];

// Statuses considerados públicos (visíveis no portal). Tudo exceto `draft`.
// Centralizado aqui para reuso em filtros server-side e UI.
export const PATHOLOGY_PUBLIC_STATUSES = PATHOLOGY_STATUSES.filter(
  (s) => s !== "draft",
);

// ═══ pathology ═══════════════════════════════════════════════════════════
export const pathology = schema.table("pathology", {
  id: text("id").default(sql`public.nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),

  // Atribuído pelo trigger BEFORE INSERT (component 017). Marca-se opcional
  // no insert type para o caller TS não ter de o passar.
  code: varchar("code", { length: 10 }),

  title: text("title").notNull(),
  description: text("description"),

  category: varchar("category", { length: 20 }).notNull().$type<PathologyCategory>(),
  status: varchar("status", { length: 30 }).default("draft").notNull().$type<PathologyStatus>(),

  affectsCommonArea: boolean("affects_common_area").default(false).notNull(),

  resolutionNotes: text("resolution_notes"),
  dismissedReason: text("dismissed_reason"),

  detectedAt: date("detected_at").notNull().default(sql`CURRENT_DATE`),
  resolvedAt: date("resolved_at"),
  dismissedAt: date("dismissed_at"),

  createdBy: actorColumn("created_by").notNull(),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
  deletedBy: actorColumn("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type PathologySelect = typeof pathology.$inferSelect;
export type PathologyInsert = typeof pathology.$inferInsert;
export type PathologyUpdate = Partial<PathologyInsert>;

// ═══ pathology_unit (N:N) ════════════════════════════════════════════════
export const pathologyUnit = schema.table("pathology_unit", {
  pathologyId: text("pathology_id").notNull(),
  unitId: text("unit_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.pathologyId, t.unitId] }),
}));

export type PathologyUnitSelect = typeof pathologyUnit.$inferSelect;
export type PathologyUnitInsert = typeof pathologyUnit.$inferInsert;
