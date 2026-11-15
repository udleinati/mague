import { decimal, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

/**
 * Voto individual de uma fração (Art. 1432-1434 CC). 1 row por (agenda_item ×
 * unit); `permillageApplied` é snapshot imutável. Trigger SQL
 * `fn_assembly_vote_aggregate` re-agrega os totais. Ver CONTEXT.md "Assembly vote".
 */
export const assemblyVote = schema.table("assembly_vote", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  assemblyAgendaItemId: text("assembly_agenda_item_id").notNull(),
  unitId: text("unit_id").notNull(),
  // 'favor' | 'against' | 'abstain' - CHECK constraint na BD.
  vote: varchar("vote", { length: 20 }).notNull(),
  permillageApplied: decimal("permillage_applied", { precision: 8, scale: 3 }).notNull(),
  // Opcional: quem executou o voto (próprio ou procurador).
  occupantId: text("occupant_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
  deletedBy: actorColumn("deleted_by"),
});

export type AssemblyVoteSelect = typeof assemblyVote.$inferSelect;
export type AssemblyVoteInsert = typeof assemblyVote.$inferInsert;
export type AssemblyVoteUpdate = Partial<AssemblyVoteInsert>;
