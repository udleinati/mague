// Single source of truth para enums do domínio: const tupla + type + zod schema.
// Valores têm de bater com o CHECK constraint da migration SQL (gate final);
// adicionar/remover valor implica sincronizar ambos os lados.

import { z } from "zod";

// ── core.unit.unit_type ─────────────────────────────────────────────────────
export const UNIT_TYPES = ["residential", "commercial"] as const;
export const UnitTypeSchema = z.enum(UNIT_TYPES);

// ── core.unit_occupant.relationship_type ────────────────────────────────────
// Fonte canónica do tipo de relação pessoa↔fração (ADR 0002 + ADR 0018).
// - owner    : proprietário (titular legal; paga quotas, vota)
// - tenant   : inquilino (contrato de arrendamento formal)
// - resident : outro residente (cônjuge, filho, parente). Recebe lembretes,
//              recibos e convocatórias como o owner (tenant fica de fora).
//              Owner-only checks (ex: direito de voto) continuam a exigir owner.
export const RELATIONSHIP_TYPES = ["owner", "tenant", "resident"] as const;
export const RelationshipTypeSchema = z.enum(RELATIONSHIP_TYPES);

// ── finance.charge.kind / nature / status ───────────────────────────────────
export const CHARGE_KINDS = ["receivable", "payable"] as const;
export type ChargeKind = typeof CHARGE_KINDS[number];
export const ChargeKindSchema = z.enum(CHARGE_KINDS);

export const CHARGE_NATURES = ["debit", "credit"] as const;
export type ChargeNature = typeof CHARGE_NATURES[number];
export const ChargeNatureSchema = z.enum(CHARGE_NATURES);

export const CHARGE_STATUSES = [
  "open",
  "partial",
  "paid",
  "overdue",
  "cancelled",
  "disputed",
] as const;
export type ChargeStatus = typeof CHARGE_STATUSES[number];
// ── core.assembly.type / status ─────────────────────────────────────────────
export const ASSEMBLY_TYPES = ["ordinary", "extraordinary"] as const;
export const AssemblyTypeSchema = z.enum(ASSEMBLY_TYPES);

// `draft` é o default: assembleia nasce em rascunho e só passa a `scheduled`
// (convocada) por ação explícita. Ver `$shared/assembly/lifecycle.ts`.
export const ASSEMBLY_STATUSES = ["draft", "scheduled", "held", "cancelled"] as const;
export const AssemblyStatusSchema = z.enum(ASSEMBLY_STATUSES);

// Statuses públicos (portal): tudo exceto `draft`, que é trabalho interno do
// administrador. Reuso nos filtros server-side do portal (ADR 0003).
export const ASSEMBLY_PUBLIC_STATUSES = ASSEMBLY_STATUSES.filter(
  (s) => s !== "draft",
);

// ── core.assembly.convocation_round ─────────────────────────────────────────
// Art. 1432.º nº 1 CC: 1ª convocatória exige >50% da permilagem; 2ª (30 min
// depois) aceita qualquer permilagem. Ata tem que registar qual.
export const ASSEMBLY_CONVOCATION_ROUNDS = ["first", "second"] as const;
export const AssemblyConvocationRoundSchema = z.enum(ASSEMBLY_CONVOCATION_ROUNDS);

// ── core.assembly_vote.vote ─────────────────────────────────────────────────
export const ASSEMBLY_VOTE_VALUES = ["favor", "against", "abstain"] as const;
export type AssemblyVoteValue = typeof ASSEMBLY_VOTE_VALUES[number];
export const AssemblyVoteValueSchema = z.enum(ASSEMBLY_VOTE_VALUES);

// ── finance.settlement.settlement_type ──────────────────────────────────────
export const SETTLEMENT_TYPES = [
  "bank_reconciliation",
  "charge_offset",
  "bank_deposit_credit",
] as const;
export type SettlementType = typeof SETTLEMENT_TYPES[number];
export const SettlementTypeSchema = z.enum(SETTLEMENT_TYPES);

// ── core.recurring_template.kind / interval_type ────────────────────────────
export const RECURRING_KINDS = ["receivable", "payable"] as const;
export const RecurringKindSchema = z.enum(RECURRING_KINDS);

export const INTERVAL_TYPES = [
  "monthly",
  "bimonthly",
  "quarterly",
  "semiannual",
  "annual",
] as const;
export const IntervalTypeSchema = z.enum(INTERVAL_TYPES);

// ── core.recurring_template.payment_method ──────────────────────────────────
// - manual         : exige ação do gestor (transferência manual, MB)
// - direct_debit   : autorizado por DD bancário (cobrança automática)
// - auto_transfer  : standing order / transferência automática agendada
export const RECURRING_PAYMENT_METHODS = ["manual", "direct_debit", "auto_transfer"] as const;
export const RecurringPaymentMethodSchema = z.enum(RECURRING_PAYMENT_METHODS);

// ── core.budget.type / status ───────────────────────────────────────────────
export const BUDGET_TYPES = ["principal", "suplementar"] as const;
export const BudgetTypeSchema = z.enum(BUDGET_TYPES);

export const BUDGET_STATUSES = ["draft", "approved", "not_approved"] as const;
// ── finance.chart_of_account.type ───────────────────────────────────────────
export const ACCOUNT_TYPES = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
] as const;
export const AccountTypeSchema = z.enum(ACCOUNT_TYPES);

// ── finance.settlement.status ───────────────────────────────────────────────
export const SETTLEMENT_STATUSES = ["active", "reversed"] as const;
export type SettlementStatus = typeof SETTLEMENT_STATUSES[number];
