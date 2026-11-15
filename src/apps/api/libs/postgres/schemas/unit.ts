import { boolean, numeric, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

export const unit = schema.table("unit", {
  id: text("id").default(sql`public.nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),
  designation: varchar("designation", { length: 50 }).notNull(),
  floor: varchar("floor", { length: 20 }),
  permillage: numeric("permillage", { precision: 7, scale: 3 }).notNull(),
  description: text("description"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  door: varchar("door", { length: 20 }),
  block: varchar("block", { length: 50 }),
  unitType: varchar("unit_type", { length: 20 }).default("residential"),
  // Stored generated column: "Bloco {block} {floor} {door}"
  // ou "Bloco {block} Loja {door}" para commercial. Read-only - nunca escrever.
  identifier: text("identifier"),
  // Palavras-chave testadas como `contains` contra a descrição dos movimentos
  // bancários na conciliação (normalizado no panel).
  matchKeywords: text("match_keywords").array().notNull().default(sql`ARRAY[]::text[]`),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: actorColumn("created_by"),
  updatedBy: actorColumn("updated_by"),
  deletedBy: actorColumn("deleted_by"),
});

export type UnitSelect = typeof unit.$inferSelect;
export type UnitInsert = typeof unit.$inferInsert;
export type UnitUpdate = Partial<UnitInsert>;
