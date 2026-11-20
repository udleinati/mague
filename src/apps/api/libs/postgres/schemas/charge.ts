import { date, integer, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("finance");

export const charge = schema.table("charge", {
  id: text("id").default(sql`nanoid(10)`).primaryKey(),
  // Code humano (`D` + 4 / `R` + 5 base-36), per (condomínio, prefix). Atribuído por
  // trigger BEFORE INSERT (component 010). Ver CONTEXT.md "Charge code".
  code: varchar("code", { length: 10 }),
  condominiumId: text("condominium_id").notNull(),
  unitId: text("unit_id"),
  scope: varchar("scope", { length: 20 }).default("unit").notNull(),
  nature: varchar("nature", { length: 6 }).notNull(), // debit | credit
  chargeType: varchar("charge_type", { length: 40 }).notNull(),
  status: varchar("status", { length: 20 }).default("open").notNull(),
  issueDate: date("issue_date").notNull(),
  dueDate: date("due_date"),
  competencePeriod: date("competence_period").notNull(),
  originalAmount: integer("original_amount").notNull(),
  settledAmount: integer("settled_amount").default(0).notNull(),
  openAmount: integer("open_amount").notNull(),
  description: text("description").default("").notNull(),
  // Nota interna do admin, NUNCA exposta no portal (ver `_projection.ts`).
  note: text("note"),
  documentNumber: varchar("document_number", { length: 50 }),
  sourceType: varchar("source_type", { length: 40 }),
  sourceId: text("source_id"),
  createdBy: actorColumn("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  kind: varchar("kind", { length: 20 }).default("receivable").notNull(),
  accountId: text("account_id"),
  expectedAmount: integer("expected_amount").default(0).notNull(),
  amount: integer("amount").default(0).notNull(),
  supplierId: text("supplier_id"),
  contractId: text("contract_id"),
  recurringTemplateId: text("recurring_template_id"),
  invoiceNumber: varchar("invoice_number", { length: 100 }),
  // Etiqueta manual despesa -> orçamento. NULL = o relatório
  // por Ata infere pela rubrica + ano. Quotas usam sourceType/sourceId.
  budgetId: text("budget_id"),
  // Snapshot do método ('manual'|'direct_debit'|'auto_transfer'), copiado do
  // recurring_template na geração. Ver CONTEXT.md "Payment method (da charge)".
  paymentMethod: varchar("payment_method", { length: 20 }).notNull().default("manual"),
  updatedBy: actorColumn("updated_by"),
  // Charge não tem soft-delete (cancelamento via status).
  // Justificação do cancelamento (interna, como `note`). NULL nas anteriores à migration 002.
  cancellationReason: text("cancellation_reason"),
});

export type ChargeSelect = typeof charge.$inferSelect;
export type ChargeInsert = typeof charge.$inferInsert;
export type ChargeUpdate = Partial<ChargeInsert>;
