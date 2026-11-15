import { boolean, integer, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

export const user = schema.table("user", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  email: varchar("email", { length: 255 }),
  // Nullable - display falls back para occupant.name.
  // Continua útil para super/admin externo que não têm occupant.
  name: varchar("name", { length: 255 }),
  // 'super' | null. Outros papéis vivem em tabelas de
  // relação (core.manager, core.unit_occupant). Ver ADR 0002.
  role: varchar("role", { length: 20 }),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  // Sem nif/phone aqui (seriam redundantes no user): vivem
  // só em core.occupant (per-condomínio).
  passwordHash: text("password_hash"),
  // `failedLoginAttempts` é counter lifetime, NÃO reseta com sucesso (audit). O
  // bloqueio temporário (5 falhas / 5 min) vive em Valkey, não aqui.
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
  failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
  lastFailedLoginAt: timestamp("last_failed_login_at", { withTimezone: true }),
  // Timestamp do último login bem-sucedido (UPDATE no
  // handler login.ts, após bcrypt.compare passar). NULL = nunca logou.
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  // Write-once via COALESCE. NULL = conta criada mas nunca
  // usada. Útil para distinguir convites por aceitar de contas ativas.
  firstLoginAt: timestamp("first_login_at", { withTimezone: true }),
  // Aceitação do aviso de privacidade. NULL = ainda não viu; o panel
  // redirecciona para /terms enquanto for NULL e o user não for super.
  termsAcknowledgedAt: timestamp("terms_acknowledged_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  // Preferência de tema UI. 'light' | 'dark' | null.
  // Cookie no browser é cache local; DB é fonte de verdade.
  theme: text("theme"),
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
  deletedBy: actorColumn("deleted_by"),
});

export type UserSelect = typeof user.$inferSelect;
export type UserInsert = typeof user.$inferInsert;
export type UserUpdate = Partial<UserInsert>;
