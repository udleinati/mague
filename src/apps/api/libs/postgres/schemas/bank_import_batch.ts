import { integer, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("finance");

export const bankImportBatch = schema.table("bank_import_batch", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  bankAccountId: text("bank_account_id").notNull(),
  condominiumId: text("condominium_id").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).defaultNow(),
  importedBy: text("imported_by"),
  filename: varchar("filename", { length: 255 }),
  rowsTotal: integer("rows_total").default(0),
  rowsImported: integer("rows_imported").default(0),
  rowsSkipped: integer("rows_skipped").default(0),
  // Append-only, sem soft-delete.
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
});
