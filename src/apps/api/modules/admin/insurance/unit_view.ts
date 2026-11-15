// Uma fração vista do lado do seguro: classificar cada apólice na janela da
// audiência, projetá-la com o gate dela e agregar (ADR 0017). Admin e portal
// entram por aqui - a audiência é a única coisa que os separa.

import {
  ADMIN_NOTICE_DAYS,
  type AggregateKind,
  aggregateUnitStatus,
  type ClassifiablePolicy,
  classifyPolicy,
  type DeletePolicyContext,
  OCCUPANT_NOTICE_DAYS,
  presumedEvidenceGap,
  type UnitInsuranceStatus,
} from "$shared/insurance/policy_status.ts";
import {
  formatInsurancePolicyWithCapabilities,
  type InsurancePolicyRowLike,
  type InsurancePolicyWithCapabilities,
} from "./_projection.ts";

/**
 * Quem está a olhar. A janela de "a expirar" e o gate de capabilities andam
 * sempre juntos: separá-los foi como o portal chegou a classificar a 30 dias
 * com os botões do condómino.
 */
export interface InsuranceAudience {
  expiringSoonDays: number;
  gateFor(policy: InsurancePolicyRowLike): DeletePolicyContext;
}

export const adminAudience: InsuranceAudience = {
  expiringSoonDays: ADMIN_NOTICE_DAYS,
  gateFor: () => ({ isAdmin: true }),
};

/** `isOwnUpload` compara o uploader com quem está a pedir (ADR 0040). */
export const occupantAudience = (userId?: string): InsuranceAudience => ({
  expiringSoonDays: OCCUPANT_NOTICE_DAYS,
  gateFor: (policy) => ({
    isAdmin: false,
    isOwnUpload: !!userId && policy.uploadedBy?.user_id === userId,
  }),
});

export interface UnitInsuranceView<R extends ClassifiablePolicy> {
  /** Estado agregado + a apólice que o justifica: o par sai sempre junto, para
   *  o badge não ficar ao lado das datas de outra apólice. */
  status: UnitInsuranceStatus<R>;
  aggregate: AggregateKind;
  /** Todas classificadas, incluindo superseded (a UI mostra o histórico). */
  policies: Array<UnitInsuranceStatus<R>>;
  /** Por status cru: "N apólices, M ativas, ...". */
  counts: Record<string, number>;
  /** Idade da renovação presumida sem comprovativo mais antiga; null se nenhuma. */
  presumedEvidenceDays: number | null;
}

/**
 * `decorate` acrescenta o que só um dos lados tem (o admin junta metadata de
 * anexos e a linhagem resolvida). Por omissão a projeção sai como está.
 */
export function unitInsuranceView<
  P extends InsurancePolicyRowLike,
  R extends ClassifiablePolicy = InsurancePolicyWithCapabilities,
>(
  policies: readonly P[],
  today: Date,
  audience: InsuranceAudience,
  decorate: (projected: InsurancePolicyWithCapabilities, raw: P) => R = (p) => p as unknown as R,
): UnitInsuranceView<R> {
  const opts = { expiringSoonDays: audience.expiringSoonDays };

  const classified = policies.map((policy) => {
    const state = classifyPolicy(policy, today, opts);
    if (!("policy" in state)) return state as UnitInsuranceStatus<R>;
    const projected = formatInsurancePolicyWithCapabilities(
      policy,
      today,
      audience.gateFor(policy),
      opts,
    );
    return { ...state, policy: decorate(projected, policy) } as UnitInsuranceStatus<R>;
  });

  const counts: Record<string, number> = {};
  for (const policy of policies) counts[policy.status] = (counts[policy.status] ?? 0) + 1;

  // A presunção mais antiga manda: é a que arrastou mais tempo sem documento.
  const gaps = policies
    .map((policy) => presumedEvidenceGap(policy, today))
    .filter((g): g is { days: number; overdue: boolean } => g !== null);

  const aggregated = aggregateUnitStatus(classified);
  return {
    status: aggregated,
    aggregate: aggregated.kind,
    policies: classified,
    counts,
    presumedEvidenceDays: gaps.length > 0 ? Math.max(...gaps.map((g) => g.days)) : null,
  };
}
