import { boolean, integer, numeric, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

export const assemblyAgendaItem = schema.table("assembly_agenda_item", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  assemblyId: text("assembly_id").notNull(),
  sequence: integer("sequence").notNull(),
  subject: varchar("subject", { length: 255 }).notNull(),
  description: text("description"),
  itemType: varchar("item_type", { length: 40 }),
  refType: varchar("ref_type", { length: 40 }),
  refId: text("ref_id"),
  votesInFavor: numeric("votes_in_favor", { precision: 8, scale: 3 }),
  votesAgainst: numeric("votes_against", { precision: 8, scale: 3 }),
  votesAbstain: numeric("votes_abstain", { precision: 8, scale: 3 }),
  approved: boolean("approved"),
  notes: text("notes"),
  voteNote: text("vote_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
  deletedBy: actorColumn("deleted_by"),
});

export type AssemblyAgendaItemSelect = typeof assemblyAgendaItem.$inferSelect;
export type AssemblyAgendaItemInsert = typeof assemblyAgendaItem.$inferInsert;
export type AssemblyAgendaItemUpdate = Partial<AssemblyAgendaItemInsert>;
