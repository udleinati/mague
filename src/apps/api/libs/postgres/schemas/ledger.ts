import { date, integer, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const schema = pgSchema("finance");

export const ledger = schema.table("ledger", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),
  unitId: text("unit_id"),
  entityType: varchar("entity_type", { length: 20 }).default("unit").notNull(),
  entryDate: date("entry_date").notNull(),
  entryType: varchar("entry_type", { length: 40 }).notNull(),
  accountCode: varchar("account_code", { length: 40 }).notNull(),
  direction: varchar("direction", { length: 6 }).notNull(), // debit | credit
  amount: integer("amount").notNull(),
  description: text("description").default("").notNull(),
  refType: varchar("ref_type", { length: 40 }),
  refId: text("ref_id"),
  // ADR 0011: ledger é populada exclusivamente por triggers - sem actor
  // column. Auditoria do "quem causou" vive nas linhas-fonte
  // (`finance.charge.created_by`, `finance.settlement.created_by`).
  // Imutável (ADR 0001), sem soft-delete.
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
