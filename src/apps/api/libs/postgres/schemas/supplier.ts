import { boolean, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

export const supplier = schema.table("supplier", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  nif: varchar("nif", { length: 20 }),
  contactName: varchar("contact_name", { length: 255 }),
  contactEmail: varchar("contact_email", { length: 255 }),
  contactPhone: varchar("contact_phone", { length: 50 }),
  accountId: text("account_id"),
  notes: text("notes"),
  isActive: boolean("is_active").default(true).notNull(),
  // Palavras-chave testadas como `contains` contra a descrição dos movimentos
  // bancários na conciliação (normalizado no panel).
  matchKeywords: text("match_keywords").array().notNull().default(sql`ARRAY[]::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: actorColumn("created_by"),
  updatedBy: actorColumn("updated_by"),
  deletedBy: actorColumn("deleted_by"),
});

export type SupplierSelect = typeof supplier.$inferSelect;
export type SupplierInsert = typeof supplier.$inferInsert;
export type SupplierUpdate = Partial<SupplierInsert>;
