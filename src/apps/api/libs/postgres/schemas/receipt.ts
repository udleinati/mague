import { integer, jsonb, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("finance");

/**
 * Recibo emitido para um pagamento bancário recebido por uma fração.
 * Modelo concetual: 1 recibo = (bank_transaction, unit). Imutável após
 * emissão exceto para anulação (campos `voided_*`) e re-envio de email.
 *
 * Ver `components/016_vw_receipt_pending.sql` para a view `vw_pending_receipts`.
 * Ver `docs/flows/01-fluxo-quotas.md § Recibo` para o desenho.
 */
export const receipt = schema.table("receipt", {
  id: text("id").default(sql`public.nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),
  unitId: text("unit_id").notNull(),
  bankTransactionId: text("bank_transaction_id").notNull(),

  // Numeração - atribuída sob lock no endpoint de emissão. Sem gaps.
  year: integer("year").notNull(),
  sequence: integer("sequence").notNull(),
  // Coluna gerada na DB (`year || '/' || lpad(seq, 5, '0')`); Drizzle
  // sabe não tentar INSERT/UPDATE quando marcada como `generatedAlwaysAs`.
  number: text("number").generatedAlwaysAs(sql`year::text || '/' || lpad(sequence::text, 5, '0')`),

  amountCents: integer("amount_cents").notNull(),

  // Lifecycle
  issuedAt: timestamp("issued_at", { withTimezone: true }).defaultNow().notNull(),
  issuedBy: jsonb("issued_by").$type<IssuedByActor>().notNull(),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: jsonb("voided_by").$type<IssuedByActor | null>(),
  voidedReason: text("voided_reason"),

  // Snapshots imutáveis (renderização determinística mesmo se template mudar)
  condominiumSnapshot: jsonb("condominium_snapshot").$type<CondominiumSnapshot>().notNull(),
  unitSnapshot: jsonb("unit_snapshot").$type<UnitSnapshot>().notNull(),
  recipientsSnapshot: jsonb("recipients_snapshot").$type<RecipientSnapshot[]>().notNull(),
  linesSnapshot: jsonb("lines_snapshot").$type<LineSnapshot[]>().notNull(),
  bankTxSnapshot: jsonb("bank_tx_snapshot").$type<BankTxSnapshot>().notNull(),

  // Storage S3
  storageKey: text("storage_key").notNull(),
  storageEtag: text("storage_etag"),
  fileSize: integer("file_size"),
  fileSha256: text("file_sha256"),

  // Email
  emailSentTo: jsonb("email_sent_to").$type<EmailSendRecord[]>().default([]).notNull(),
  emailLastAttemptAt: timestamp("email_last_attempt_at", { withTimezone: true }),

  // Tracking de PDF download por recipient (Q1+Q2 - só primeiro download,
  // 1 entry por occupant). Append-if-not-exists.
  recipientsAccess: jsonb("recipients_access").$type<ReceiptAccessRecord[]>().default([]).notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  updatedBy: actorColumn("updated_by").notNull().default(sql`'{}'::jsonb`),
  // Anulação via voided_at/voided_by, sem soft-delete.
});

export type ReceiptSelect = typeof receipt.$inferSelect;
export type ReceiptInsert = typeof receipt.$inferInsert;
export type ReceiptUpdate = Partial<ReceiptInsert>;

// ─── Tipos dos snapshots JSONB ──────────────────────────────────────────

export interface IssuedByActor {
  id: string;
  name: string;
  email?: string | null;
  role?: string | null; // 'super' | 'manager' | 'system'
}

export interface CondominiumSnapshot {
  name: string;
  // Optional: snapshots antigos não têm o campo. Default 'condominium'
  // ao ler.
  designationType?: "building" | "condominium";
  fiscalNumber: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
}

export interface UnitSnapshot {
  designation: string;
  identifier: string | null;
  permillage: number;
  unitType: string | null;
}

export interface RecipientSnapshot {
  occupantId: string;
  name: string;
  nif: string | null;
  email: string | null;
  receiveEmails: boolean;
}

export interface LineSnapshot {
  /** Descrição amigável (ex: "Quota Janeiro/2026") */
  description: string;
  /** Valor em cêntimos */
  amount: number;
  /** Tipo da charge para colorir/agrupar (quota, supplier_service, refacturation, ...) */
  chargeType: string;
  /** Periodo de competência YYYY-MM-DD se aplicável (1º dia do mês) */
  competencePeriod: string | null;
  /** Se for quota com FCR, parte FCR já incluída no `amount` (cêntimos). null se N/A */
  fcrAmount?: number | null;
}

export interface BankTxSnapshot {
  /** YYYY-MM-DD */
  transactionDate: string;
  description: string | null;
  /** 'bank' | 'cash' */
  accountKind: string;
  accountName: string;
  /** IBAN mascarado: `PT50 **** **** **** **** **** 4321` ou null para cash */
  ibanMasked: string | null;
}

export interface EmailSendRecord {
  email: string;
  /** ISO timestamp */
  sentAt: string;
  /** 'sent' | 'failed' */
  status: string;
  error?: string;
}

/**
 * Carimbo de "primeira vez que este recipient descarregou o PDF".
 * Append-if-not-exists no array `recipients_access` da receipt. Write-once
 * por occupant.
 */
export interface ReceiptAccessRecord {
  occupantId: string;
  /** ISO timestamp da primeira (e única gravada) vez que descarregou. */
  firstDownloadedAt: string;
  /** Snapshot do nome no momento - facilita listagem em UI sem join. */
  occupantName: string;
}
