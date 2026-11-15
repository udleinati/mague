// Read-model: agrega o estado do seguro por fração para a UI admin. Lê de
// `core.vw_unit_insurance_status`; classificação/seleção são puras e vivem em
// `$shared/insurance/policy_status.ts` - aqui só a query + composição.

import { sql } from "drizzle-orm";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import type { InsurancePolicySelect } from "$api/libs/postgres/schemas/mod.ts";
import {
  type AggregateKind,
  type UnitInsuranceStatus,
  type UnitUpdateAction,
  unitUpdateAction,
} from "$shared/insurance/policy_status.ts";
import {
  type InsurancePolicyWithCapabilities,
  type RenewedFromRef,
  toRenewedFromRef,
} from "./_projection.ts";
import { adminAudience, unitInsuranceView } from "./unit_view.ts";

// Extras que a view acrescenta ao JSONB de cada policy (metadata de anexos).
type PolicyViewExtras = {
  primaryAttachment?: { id: string; mimeType: string; filename: string } | null;
  attachmentCount?: number;
  attachments?: Array<{ id: string; mimeType: string; filename: string }>;
};
type PolicyViewRow = InsurancePolicySelect & PolicyViewExtras;
export type PolicyViewResponse =
  & InsurancePolicyWithCapabilities
  & PolicyViewExtras
  & { renewedFrom: RenewedFromRef | null };

/** Predecessor por id, dentro da mesma fração - a view já traz todas as
 *  apólices, logo a linhagem resolve-se sem query extra. */
type PolicyLookup = Map<string, PolicyViewRow>;

// Extras que só o admin tem: metadata de anexos que a view agrega, e a
// linhagem já resolvida (o predecessor vem no mesmo conjunto, sem query extra).
const decorateForAdmin = (
  projected: InsurancePolicyWithCapabilities,
  raw: PolicyViewRow,
  byId: PolicyLookup,
): PolicyViewResponse => ({
  ...projected,
  primaryAttachment: raw.primaryAttachment ?? null,
  attachmentCount: raw.attachmentCount ?? 0,
  attachments: raw.attachments ?? [],
  renewedFrom: toRenewedFromRef(raw.renewedFromId ? byId.get(raw.renewedFromId) : null),
});

// ═══ Lista de status por unit ═════════════════════════════════════════════════
// Uma só query (sem N+1). NÃO mover a regra "qual policy mostrar" de volta para
// SQL: já custou um bug onde um pending_review ficava escondido sob uma active
// (renovação). Vive em TS, e `policies` traz todas para a UI não esconder nenhuma.

/** Linha crua da view, tal como sai do SQL. `type` e não `interface`: o
 *  `db.execute<T>` exige um índice implícito, que só os type aliases têm. */
export type UnitStatusViewRow = {
  unit_id: string;
  designation: string;
  identifier: string | null;
  policies: PolicyViewRow[];
  last_reminder_at: string | null;
  last_renewal_evidence_at: string | null;
  has_occupant_with_email: boolean;
  occupants: Array<{ name: string; relationshipType: string }> | null;
};

export interface UnitStatusRow {
  unit: { id: string; designation: string; identifier: string | null };
  /** Estado agregado + a apólice que o justifica. Mesmo par que `aggregate`. */
  status: UnitInsuranceStatus<PolicyViewResponse>;
  /** `status.kind` (best across policies; active vence awaiting_*). */
  aggregate: AggregateKind;
  counts: Record<string, number>;
  /** Todas as policies classificadas + projeção, para per-policy actions na UI. */
  policies: Array<UnitInsuranceStatus<PolicyViewResponse>>;
  lastReminderAt: Date | null;
  /** Último pedido de comprovativo de renovação (família de trigger própria,
   *  com cooldown próprio - não cega o botão "Lembrar"). */
  lastRenewalEvidenceAt: Date | null;
  /** Idade, em dias, da renovação presumida sem comprovativo mais antiga da
   *  fração; `null` quando não há nenhuma. KPI, filtro e alvo do bulk. */
  presumedEvidenceDays: number | null;
  hasOccupantWithEmail: boolean;
  occupants: Array<{ name: string; relationshipType: string }>;
  /** Botão "Atualizar" da lista, com o mesmo `today` dos `can.*` (ver `unitUpdateAction`). */
  updateAction: UnitUpdateActionRef;
}

/** `UnitUpdateAction` com a apólice por id - o detalhe já vem em `policies`. */
export type UnitUpdateActionRef =
  | { kind: "review" }
  | { kind: "renew"; policyId: string }
  | { kind: "register" };

export async function listUnitsStatus(
  postgres: Postgres,
  condominiumId: string,
  filters: { unitId?: string } = {},
): Promise<UnitStatusRow[]> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const rows = await postgres.query((db) =>
    db.execute<UnitStatusViewRow>(sql`
      SELECT unit_id, designation, identifier,
             policies,
             last_reminder_at, last_renewal_evidence_at, has_occupant_with_email,
             occupants
        FROM core.vw_unit_insurance_status
       WHERE condominium_id = ${condominiumId}
         AND (${filters.unitId ?? null}::text IS NULL OR unit_id = ${filters.unitId ?? null})
       -- Ordem natural Excel-like: A, B, …, Z, AA, AB, … (ver ADR 0014).
       ORDER BY length(designation), designation
    `)
  );

  return rows.map((row) => composeUnitStatus(row, today));
}

/**
 * Linha da view -> linha da resposta. Pura, para ser testável sem BD: é aqui que
 * o badge (`aggregate`) e o detalhe (`status`) têm de sair do MESMO par.
 */
export function composeUnitStatus(row: UnitStatusViewRow, today: Date): UnitStatusRow {
  const allPolicies = row.policies ?? [];
  const byId: PolicyLookup = new Map(allPolicies.map((p) => [p.id, p]));

  const view = unitInsuranceView(
    allPolicies,
    today,
    adminAudience,
    (projected, raw) => decorateForAdmin(projected, raw, byId),
  );

  return {
    unit: { id: row.unit_id, designation: row.designation, identifier: row.identifier },
    status: view.status,
    aggregate: view.aggregate,
    counts: view.counts,
    policies: view.policies,
    lastReminderAt: row.last_reminder_at ? new Date(row.last_reminder_at) : null,
    lastRenewalEvidenceAt: row.last_renewal_evidence_at
      ? new Date(row.last_renewal_evidence_at)
      : null,
    presumedEvidenceDays: view.presumedEvidenceDays,
    hasOccupantWithEmail: Boolean(row.has_occupant_with_email),
    occupants: row.occupants ?? [],
    updateAction: toUpdateActionRef(unitUpdateAction(allPolicies, today)),
  };
}

function toUpdateActionRef(action: UnitUpdateAction<PolicyViewRow>): UnitUpdateActionRef {
  return action.kind === "renew" ? { kind: "renew", policyId: action.policy.id } : action;
}
