// Projection de apólices de seguro (mesmo padrão de inspection/_projection.ts).
// ADR 0011: os campos ActorSnapshot (uploadedBy/confirmedBy/approvedBy/
// rejectedBy/createdBy/updatedBy) NUNCA saem em respostas da API.

import type { InsurancePolicySelect } from "$api/libs/postgres/schemas/insurance_policy.ts";
import {
  type ClassifyOptions,
  classifyPolicy,
  type DeletePolicyContext,
  isAdminDocumented,
  policyCapabilities,
  presumedEvidenceGap,
} from "$shared/insurance/policy_status.ts";

// `status` obrigatório: classifyPolicy e a UI dependem dele. `attachmentCount`
// vem da view (só no read-model do admin) e alimenta os gates de evidência.
export type InsurancePolicyRowLike =
  & Partial<InsurancePolicySelect>
  & Pick<InsurancePolicySelect, "status">
  & { attachmentCount?: number };

export function formatInsurancePolicyForResponse(row: InsurancePolicyRowLike) {
  return {
    id: row.id,
    condominiumId: row.condominiumId,
    unitId: row.unitId,
    validFrom: row.validFrom,
    validTo: row.validTo,
    policyNumber: row.policyNumber ?? null,
    insurer: row.insurer ?? null,
    ocrExtracted: row.ocrExtracted ?? null,
    ocrConfidence: row.ocrConfidence ?? null,
    presumedAt: row.presumedAt ?? null,
    evidenceSource: row.evidenceSource ?? null,
    supersededAt: row.supersededAt ?? null,
    coverageAmountCents: row.coverageAmountCents ?? null,
    renewedFromId: row.renewedFromId ?? null,
    status: row.status,
    confirmedAt: row.confirmedAt ?? null,
    approvedAt: row.approvedAt ?? null,
    rejectedAt: row.rejectedAt ?? null,
    rejectedReason: row.rejectedReason ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Projeção + estado computado (`kind`) + gates de ação (`can.*`). A UI consulta-os
 * em vez de reimplementar as regras nos templates - ver ADR 0040 e os predicados
 * em `$shared/insurance/policy_status.ts`. `kind` existe porque o `status` cru
 * mente sobre a vigência: uma apólice vencida continua `active` na BD.
 *
 * `opts` só afeta `kind` (a fronteira active/expiring_soon). Nenhum gate depende
 * dela - renovar, anexar e eliminar tratam as duas da mesma maneira.
 *
 * `presumedEvidence` é a idade da renovação sem comprovativo (null quando não se
 * aplica); a UI mostra o badge a partir dela em vez de recompor a regra. Mesmo
 * racional para `adminDocumented` (evidência entregue à administração, não
 * submetida no portal); no portal dá sempre falso - as rows de lá não trazem
 * `attachmentCount` -, mas essa superfície é só do admin.
 */
export function formatInsurancePolicyWithCapabilities(
  row: InsurancePolicyRowLike,
  today: Date,
  ctx: DeletePolicyContext,
  opts: ClassifyOptions = {},
) {
  return {
    ...formatInsurancePolicyForResponse(row),
    kind: classifyPolicy(row, today, opts).kind,
    can: policyCapabilities(row, today, ctx),
    presumedEvidence: presumedEvidenceGap(row, today),
    adminDocumented: isAdminDocumented(row),
  };
}

export type InsurancePolicyWithCapabilities = ReturnType<
  typeof formatInsurancePolicyWithCapabilities
>;

/** Referência ao predecessor para a UI desenhar a cadeia de renovações sem ir
 *  buscar a apólice inteira. A linhagem do ADR 0040 existia e nunca aparecia. */
export interface RenewedFromRef {
  id: string;
  policyNumber: string | null;
  validFrom: string | null;
  validTo: string | null;
}

export function toRenewedFromRef(
  p:
    | {
      id?: string;
      policyNumber?: string | null;
      validFrom?: string | null;
      validTo?: string | null;
    }
    | null
    | undefined,
): RenewedFromRef | null {
  if (!p?.id) return null;
  return {
    id: p.id,
    policyNumber: p.policyNumber ?? null,
    validFrom: p.validFrom ?? null,
    validTo: p.validTo ?? null,
  };
}
