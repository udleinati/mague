import { date, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

export const unitOccupant = schema.table("unit_occupant", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  unitId: text("unit_id").notNull(),
  occupantId: text("occupant_id").notNull(),
  relationshipType: varchar("relationship_type", { length: 20 }).notNull().default("owner"),
  startDate: date("start_date").notNull().default(sql`CURRENT_DATE`),
  endDate: date("end_date"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
  deletedBy: actorColumn("deleted_by"),
});

export type UnitOccupantSelect = typeof unitOccupant.$inferSelect;
export type UnitOccupantInsert = typeof unitOccupant.$inferInsert;
export type UnitOccupantUpdate = Partial<UnitOccupantInsert>;
