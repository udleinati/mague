import { boolean, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

export const occupant = schema.table("occupant", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  userId: text("user_id"),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }),
  nif: varchar("nif", { length: 20 }),
  phone: varchar("phone", { length: 30 }),
  // Natureza jurídica: pessoa singular vs pessoa coletiva (empresa). Controla
  // a redação e o rótulo fiscal (NIF/NIPC) da procuração.
  personType: varchar("person_type", { length: 20 }).notNull().default("singular"),
  condominiumId: text("condominium_id").notNull(),
  isActive: boolean("is_active").default(true),
  // Preferência por-owner para receber emails de recibos.
  receiveReceiptEmails: boolean("receive_receipt_emails").notNull().default(true),
  // Tracking de login no portal (write-once + last).
  // `inet` em Postgres → text/string em Drizzle (sem tipo nativo dedicado).
  firstLoginAt: timestamp("first_login_at", { withTimezone: true }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  lastLoginIp: text("last_login_ip"),
  lastLoginUserAgent: text("last_login_user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: actorColumn("created_by"),
  updatedBy: actorColumn("updated_by"),
  deletedBy: actorColumn("deleted_by"),
});

export type OccupantSelect = typeof occupant.$inferSelect;
export type OccupantInsert = typeof occupant.$inferInsert;
export type OccupantUpdate = Partial<OccupantInsert>;
