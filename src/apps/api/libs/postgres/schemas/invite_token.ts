import { pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

export const inviteToken = schema.table("invite_token", {
  token: text("token").primaryKey(),
  userId: text("user_id").notNull(),
  /** "invite" | "reset" */
  purpose: varchar("purpose", { length: 20 }).notNull(),
  // ADR 0011: jsonb ActorSnapshot. `{}` para fluxos sem actor (forgot-password).
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  /** Condomínios geridos por quem convidou; o aceite revalida contra eles. NULL = sem limite. */
  scopeCondominiumIds: text("scope_condominium_ids").array(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).default(sql`now()`).notNull(),
});

export type InviteTokenSelect = typeof inviteToken.$inferSelect;
export type InviteTokenInsert = typeof inviteToken.$inferInsert;
