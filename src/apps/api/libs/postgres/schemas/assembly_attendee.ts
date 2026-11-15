import { boolean, decimal, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

/**
 * Presença numa assembleia (Art. 1432.º + 1434.º CC).
 *
 * 1 row por (assembleia × unit × convocação). Com procuração (Art. 1431.º nº 5)
 * a linha fica com `isProxy=true`: `occupantId` é o titular representado e o
 * portador vai em `proxyHolderOccupantId` XOR `proxyHolderExternalName`.
 *
 * `permillageAtMeeting` é **snapshot** - imutável após registo. Ver
 * CONTEXT.md "Assembly attendee".
 */
export const assemblyAttendee = schema.table("assembly_attendee", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  assemblyId: text("assembly_id").notNull(),
  unitId: text("unit_id").notNull(),
  // Per-convocação (Art. 1432.º nº 4 CC). Uma assembleia pode ter
  // presenças diferentes na 1ª e na 2ª - DB UNIQUE inclui este campo.
  convocationRound: varchar("convocation_round", { length: 20 }).notNull().default("first"),
  // Titular dos votos desta linha (o representado, quando isProxy=true).
  occupantId: text("occupant_id").notNull(),
  permillageAtMeeting: decimal("permillage_at_meeting", { precision: 8, scale: 3 }).notNull(),
  isProxy: boolean("is_proxy").notNull().default(false),
  // Portador da procuração quando isProxy=true: occupant interno (FK) OU nome
  // externo livre. XOR - exactamente um preenchido (CHECK na BD).
  // `occupant_id` continua a ser o titular (representado).
  proxyHolderOccupantId: text("proxy_holder_occupant_id"),
  proxyHolderExternalName: text("proxy_holder_external_name"),
  arrivedAt: timestamp("arrived_at", { withTimezone: true }),
  leftAt: timestamp("left_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
  deletedBy: actorColumn("deleted_by"),
});

export type AssemblyAttendeeSelect = typeof assemblyAttendee.$inferSelect;
export type AssemblyAttendeeInsert = typeof assemblyAttendee.$inferInsert;
export type AssemblyAttendeeUpdate = Partial<AssemblyAttendeeInsert>;
