import {
  boolean,
  date,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("finance");

export const bankAccount = schema.table("bank_account", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),
  bankName: varchar("bank_name", { length: 100 }).notNull(),
  iban: varchar("iban", { length: 34 }),
  accountName: varchar("account_name", { length: 255 }),
  // Titular da conta (PT-PT) - mostrado ao condómino no portal de pagamento.
  accountHolder: text("account_holder"),
  // Conta destino para pagamento de quotas. Só permitido para kind=bank
  // (CHECK constraint na DB). Múltiplas contas podem ter true.
  isQuotaPayment: boolean("is_quota_payment").default(false).notNull(),
  // 'bank' = conta real (import CSV); 'cash' = caixa, inserção manual de cada
  // recebimento.
  kind: varchar("kind", { length: 10 }).default("bank").notNull(),
  isActive: boolean("is_active").default(true),
  csvConfig: jsonb("csv_config").$type<Record<string, unknown>>(),
  openingBalance: integer("opening_balance").default(0).notNull(),
  openingBalanceOrdinaryCents: integer("opening_balance_ordinary_cents").default(0).notNull(),
  openingBalanceFcrCents: integer("opening_balance_fcr_cents").default(0).notNull(),
  openingBalanceDate: date("opening_balance_date"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
  deletedBy: actorColumn("deleted_by"),
});

export type BankAccountSelect = typeof bankAccount.$inferSelect;
export type BankAccountInsert = typeof bankAccount.$inferInsert;
export type BankAccountUpdate = Partial<BankAccountInsert>;
