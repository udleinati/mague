import { boolean, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("finance");

export const chartOfAccount = schema.table("chart_of_account", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  code: varchar("code", { length: 20 }).notNull(),
  condominiumId: text("condominium_id"), // NULL = global
  name: varchar("name", { length: 150 }).notNull(),
  type: varchar("type", { length: 20 }).notNull(), // asset|liability|equity|revenue|expense
  parentCode: varchar("parent_code", { length: 20 }),
  isActive: boolean("is_active").default(true).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
  deletedBy: actorColumn("deleted_by"),
});

export type ChartOfAccountSelect = typeof chartOfAccount.$inferSelect;
export type ChartOfAccountInsert = typeof chartOfAccount.$inferInsert;
export type ChartOfAccountUpdate = Partial<ChartOfAccountInsert>;
