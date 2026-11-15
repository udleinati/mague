import { date, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

export const assembly = schema.table("assembly", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),
  type: varchar("type", { length: 20 }).notNull(), // ordinary | extraordinary
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  // 2ª convocatória, intervalo escolhido pelo admin (Art. 1432.º nº 4 CC).
  // DB CHECK: second_convocation_at >= scheduled_at.
  secondConvocationAt: timestamp("second_convocation_at", { withTimezone: true }),
  heldAt: timestamp("held_at", { withTimezone: true }),
  location: varchar("location", { length: 255 }),
  convocationSentAt: timestamp("convocation_sent_at", { withTimezone: true }),
  // 'first' | 'second' - Art. 1432.º nº 1 (1ª exige >50% permilagem, 2ª qualquer).
  convocationRound: varchar("convocation_round", { length: 20 }).notNull().default("first"),
  // Presidente + secretário assinam ata (Art. 1434.º). Os 3 campos (president,
  // secretary, signed_at) ou todos NULL ou todos preenchidos - CHECK na BD.
  presidentOccupantId: text("president_occupant_id"),
  secretaryOccupantId: text("secretary_occupant_id"),
  // `date` (não timestamp): a ata assina-se num dia, sem ambiguidade de
  // timezone. Drizzle devolve string ISO `YYYY-MM-DD`.
  minutesSignedAt: date("minutes_signed_at"),
  minutesNumber: varchar("minutes_number", { length: 50 }),
  minutesDocumentId: text("minutes_document_id"),
  // Máquina de vida em `$shared/assembly/lifecycle.ts` (nasce em `draft`).
  status: varchar("status", { length: 20 }).default("draft").notNull(),
  // Texto narrativo da ATA (antes/depois das deliberações). Distinto de `notes`
  // (interno, não sai na ata).
  introduction: text("introduction"),
  conclusion: text("conclusion"),
  // Texto livre da CONVOCATÓRIA (não da ata): intro abre, footer é o rodapé.
  // Editáveis só em `draft`.
  convocationIntro: text("convocation_intro"),
  convocationFooter: text("convocation_footer"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
  deletedBy: actorColumn("deleted_by"),
});

export type AssemblySelect = typeof assembly.$inferSelect;
export type AssemblyInsert = typeof assembly.$inferInsert;
export type AssemblyUpdate = Partial<AssemblyInsert>;
