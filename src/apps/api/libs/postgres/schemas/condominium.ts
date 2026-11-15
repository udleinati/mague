import { boolean, date, integer, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

export const condominium = schema.table("condominium", {
  id: text("id").default(sql`public.nanoid(6)`).primaryKey(),
  name: text("name").notNull(),
  // 'building' = edifício único; 'condominium' = vários edifícios / empreendimento.
  // Determina o termo usado em comunicações (cabeçalho de emails, recibos, etc.).
  // CHECK em SQL garante que só estes dois valores existem.
  designationType: text("designation_type").$type<"building" | "condominium">().notNull().default(
    "condominium",
  ),
  fiscalNumber: text("fiscal_number"),
  email: varchar("email", { length: 255 }),
  // Quando preenchido, todos os emails enviados em nome
  // deste condomínio levam este endereço em BCC. Exceção: reset password.
  bccEmail: text("bcc_email"),
  // `Reply-To` dos emails deste condo (tipicamente o gestor). Exceção: reset
  // password (vai sempre para o transport default).
  replyToEmail: text("reply_to_email"),
  address: text("address"),
  city: text("city"),
  postalCode: text("postal_code"),
  quotaDayOfMonth: integer("quota_day_of_month").default(1),
  // Nota livre da administração no topo do email de lembrete (ADR 0028).
  // Editada na página de billing-reminders. NULL/vazio = sem caixa.
  billingReminderNote: text("billing_reminder_note"),
  // Equivalente para o email de lembrete de seguro (espelha a de billing,
  // independente). Editada na página de seguros. NULL/vazio = sem caixa.
  insuranceReminderNote: text("insurance_reminder_note"),
  // Data até à qual o admin garante ter feito a conciliação bancária.
  // Driver da view v_unit_balance (overdue) e display no portal do
  // condómino. NULL = nunca declarado.
  reconciledThroughDate: date("reconciled_through_date"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
  deletedBy: actorColumn("deleted_by"),
});

export type CondominiumSelect = typeof condominium.$inferSelect;
export type CondominiumInsert = typeof condominium.$inferInsert;
export type CondominiumUpdate = Partial<CondominiumInsert>;
