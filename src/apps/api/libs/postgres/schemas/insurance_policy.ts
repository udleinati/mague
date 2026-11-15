import { date, integer, jsonb, pgSchema, text, timestamp, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { actorColumn } from "./_audit.ts";

const schema = pgSchema("core");

/**
 * Estados permitidos para `insurance_policy.status`. Allowlist enforçada
 * via CHECK constraint - ver ADR 0016 (state machine).
 */
export type InsurancePolicyStatus =
  | "pending_review"
  | "active"
  | "rejected"
  | "superseded";

/**
 * Origem da evidência. NULL = sem documento (renovação presumida); `unit` =
 * comprovativo submetido no portal pela fração; `admin` = documento entregue à
 * administração fora do portal. Ver ADR 0016.
 */
export const EVIDENCE_SOURCES = ["unit", "admin"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export interface OcrExtracted {
  /** Datas candidatas detetadas pelo OCR - utilizador escolhe/confirma. */
  candidatesValidUntil?: string[];
  candidatesValidFrom?: string[];
  /** Texto bruto extraído (debug). Truncado a ~5 KB para não inchar o JSONB. */
  rawText?: string;
  /** Outras heurísticas opcionais. */
  policyNumberCandidate?: string;
  insurerCandidate?: string;
}

export const insurancePolicy = schema.table("insurance_policy", {
  id: text("id").default(sql`public.nanoid(10)`).primaryKey(),
  condominiumId: text("condominium_id").notNull(),
  unitId: text("unit_id").notNull(),

  // Sem storage fields aqui - ficheiros vivem em
  // `core.attachment` (entity_type='insurance', entity_id=policy.id).

  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to").notNull(),

  policyNumber: text("policy_number"),
  insurer: text("insurer"),
  // Sem `premium_cents`/`deductible_cents`/`coverages`: só o capital segurado é guardado.

  ocrExtracted: jsonb("ocr_extracted").$type<OcrExtracted>(),
  ocrConfidence: varchar("ocr_confidence", { length: 20 }),

  // Campos do modelo per-fração.
  // Ver ADR 0016 + ADR 0017 para a semântica.
  presumedAt: timestamp("presumed_at", { withTimezone: true }),
  evidenceSource: varchar("evidence_source", { length: 10 }).$type<EvidenceSource>(),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  coverageAmountCents: integer("coverage_amount_cents"),

  // Linhagem de renovação (ADR 0040): aponta para a apólice
  // predecessora imediata (caminho admin renew). NULL em uploads de raiz. FK
  // self ON DELETE RESTRICT na BD impede quebrar a cadeia em silêncio.
  renewedFromId: text("renewed_from_id"),

  status: varchar("status", { length: 20 }).default("pending_review").notNull(),

  confirmedBy: actorColumn("confirmed_by"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),

  approvedBy: actorColumn("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),

  rejectedBy: actorColumn("rejected_by"),
  rejectedAt: timestamp("rejected_at", { withTimezone: true }),
  rejectedReason: text("rejected_reason"),

  uploadedBy: actorColumn("uploaded_by").notNull(),
  createdBy: actorColumn("created_by").notNull().default(sql`'{}'::jsonb`),
  updatedBy: actorColumn("updated_by"),
  // Approve/reject via status, sem soft-delete.
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type InsurancePolicySelect = typeof insurancePolicy.$inferSelect;
export type InsurancePolicyInsert = typeof insurancePolicy.$inferInsert;
export type InsurancePolicyUpdate = Partial<InsurancePolicyInsert>;
