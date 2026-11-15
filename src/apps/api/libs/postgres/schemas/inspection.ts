import { boolean, date, integer, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

export const inspection = schema.table("inspection", {
  id: text("id").default(sql`public.nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),

  // Identificador humano per-condomínio (ADR 0023). Atribuído pelo trigger
  // BEFORE INSERT do component 019. Formato: `I` + 3 dígitos base-36.
  code: varchar("code", { length: 10 }),

  category: varchar("category", { length: 20 }).notNull(),
  description: text("description").notNull(),

  lastDoneDate: date("last_done_date"),
  validUntil: date("valid_until").notNull(),
  notifyDaysBefore: integer("notify_days_before").default(30).notNull(),

  notes: text("notes"),

  /** Fornecedor que realiza a inspeção (FK opcional, ON DELETE SET NULL). */
  supplierId: text("supplier_id"),

  /** false = não conta para alertas nem aparece no portal (mas visível no
   *  admin). Independente de deletedAt. */
  isActive: boolean("is_active").default(true).notNull(),

  createdBy: actorColumn("created_by").notNull(),
  updatedBy: actorColumn("updated_by"),
  deletedBy: actorColumn("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type InspectionSelect = typeof inspection.$inferSelect;
export type InspectionInsert = typeof inspection.$inferInsert;
export type InspectionUpdate = Partial<InspectionInsert>;

export const INSPECTION_CATEGORIES = [
  "fire_extinguisher",
  "fire_detection",
  "elevator",
  "gas",
  "electricity",
  "lightning_rod",
  "hvac",
  "pool",
  "antenna",
  "other",
] as const;

export type InspectionCategory = (typeof INSPECTION_CATEGORIES)[number];
