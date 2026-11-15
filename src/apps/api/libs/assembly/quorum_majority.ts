// Helpers puros para validação de quórum e maiorias em assembleias de
// condomínio (Código Civil PT, Art. 1432.º).
//
// "Puros" = sem DB, sem side-effects, sem actor. Recebe números agregados,
// devolve decisão lógica. Os call sites (handlers, panel) chamam estes
// helpers para validar input antes de aceitar transições de estado.

import type { AssemblyVoteValue } from "$api/libs/enums.ts";

// ─── Quórum ─────────────────────────────────────────────────────────────────

export interface QuorumInput {
  /** Soma da permilagem de TODOS os attendees (presença + procuração). */
  totalAttendeePermillage: number;
  /** Permilagem total do edifício (soma de todas as units, geralmente 1000). */
  totalBuildingPermillage: number;
  /** 'first' = 1ª convocatória (exige >50%); 'second' = 2ª (qualquer). */
  round: "first" | "second";
}

export interface QuorumResult {
  hasQuorum: boolean;
  /** Razão legível em PT - útil para mostrar na UI quando não há quórum. */
  reason: string;
  /** Permilagem mínima exigida para a `round`. */
  requiredPermillage: number;
}

// Quórum (Art. 1432.º nº 1 CC): 1ª convocatória exige >50% da permilagem do
// edifício; 2ª (30 min depois) aceita qualquer permilagem > 0.
export function calculateAssemblyQuorum(input: QuorumInput): QuorumResult {
  const { totalAttendeePermillage, totalBuildingPermillage, round } = input;

  if (totalBuildingPermillage <= 0) {
    return {
      hasQuorum: false,
      reason: "Edifício sem permilagem total definida.",
      requiredPermillage: 0,
    };
  }

  if (round === "second") {
    // 2ª convocatória: qualquer permilagem > 0 chega.
    const hasQuorum = totalAttendeePermillage > 0;
    return {
      hasQuorum,
      reason: hasQuorum
        ? `Quórum em 2ª convocatória (${totalAttendeePermillage} de ${totalBuildingPermillage} ‰).`
        : "Sem permilagem presente sequer na 2ª convocatória.",
      requiredPermillage: 0,
    };
  }

  // 1ª convocatória: maioria estrita (>50%).
  const requiredPermillage = totalBuildingPermillage / 2;
  const hasQuorum = totalAttendeePermillage > requiredPermillage;
  return {
    hasQuorum,
    reason: hasQuorum
      ? `Quórum em 1ª convocatória: ${totalAttendeePermillage} > ${requiredPermillage} ‰ (maioria estrita).`
      : `Sem maioria na 1ª convocatória: ${totalAttendeePermillage} ≤ ${requiredPermillage} ‰. ` +
        `Marca como 2ª convocatória se aplicável.`,
    requiredPermillage,
  };
}

// ─── Maiorias por item_type ─────────────────────────────────────────────────

// Maioria exigida por `item_type` (default "simple"):
// - simple: favor > contra, presentes/representados (Art. 1432.º nº 1).
// - two_thirds: 2/3 da permilagem PRESENTE (Art. 1432.º nº 3, obras de custo).
// - unanimous: 100% da permilagem TOTAL (Art. 1422.º nº 2, título constitutivo).
const ITEM_TYPE_MAJORITY: Record<string, "simple" | "two_thirds" | "unanimous"> = {
  approve_budget: "simple",
  accounts_approval: "simple",
  admin_election: "simple",
  approve_fcr_usage: "two_thirds", // Uso do FCR para obras (Art. 1432.º nº 3 b)).
  info: "simple",
  other: "simple",
};

export type RequiredMajority = "simple" | "two_thirds" | "unanimous";

export function requiredMajorityForType(itemType: string | null | undefined): RequiredMajority {
  if (!itemType) return "simple";
  return ITEM_TYPE_MAJORITY[itemType] ?? "simple";
}

// ─── Validação de aprovação ─────────────────────────────────────────────────

export interface MajorityInput {
  votesInFavor: number;
  votesAgainst: number;
  votesAbstain: number;
  /** Permilagem total do edifício (denominador para unanimous). */
  totalBuildingPermillage: number;
}

export interface MajorityResult {
  approved: boolean;
  /** Razão legível em PT. */
  reason: string;
}

// Aprovação por tipo de maioria:
// - simple: favor > contra (abstenções não contam).
// - two_thirds: favor >= 2/3 do presente (favor+contra+abstain no denominador).
// - unanimous: favor == permilagem TOTAL (contra ou ausência bloqueiam).
export function validateDeliberationMajority(
  required: RequiredMajority,
  input: MajorityInput,
): MajorityResult {
  const { votesInFavor, votesAgainst, votesAbstain, totalBuildingPermillage } = input;
  const totalPresent = votesInFavor + votesAgainst + votesAbstain;

  if (required === "simple") {
    const approved = votesInFavor > votesAgainst;
    return {
      approved,
      reason: approved
        ? `Aprovada por maioria simples: ${votesInFavor} > ${votesAgainst} ‰.`
        : `Reprovada por maioria simples: ${votesInFavor} ≤ ${votesAgainst} ‰.`,
    };
  }

  if (required === "two_thirds") {
    if (totalPresent <= 0) {
      return { approved: false, reason: "Sem permilagem presente para calcular 2/3." };
    }
    const threshold = (2 * totalPresent) / 3;
    const approved = votesInFavor >= threshold;
    return {
      approved,
      reason: approved
        ? `Aprovada por 2/3 dos presentes: ${votesInFavor} ≥ ${threshold.toFixed(3)} ‰.`
        : `Reprovada: ${votesInFavor} < ${threshold.toFixed(3)} ‰ (2/3 dos presentes).`,
    };
  }

  // unanimous
  const approved = votesInFavor >= totalBuildingPermillage;
  return {
    approved,
    reason: approved
      ? `Aprovada por unanimidade: ${votesInFavor} ‰ = total do edifício.`
      : `Reprovada: unanimidade exige ${totalBuildingPermillage} ‰; obtido ${votesInFavor} ‰.`,
  };
}

// ─── Resultado derivado dos votos ───────────────────────────────────────────

// Deriva `approved` das somas de votos + `item_type` (sempre calculado, nunca
// à mão - CLAUDE.md Regra 5). `info` ou soma 0 de votos -> null (pendente);
// caso contrário aplica `validateDeliberationMajority`.
export function deriveApprovedFromVotes(
  itemType: string | null | undefined,
  agg: { votesInFavor: number; votesAgainst: number; votesAbstain: number },
  totalBuildingPermillage: number,
): boolean | null {
  if (itemType === "info") return null;
  const totalVotes = agg.votesInFavor + agg.votesAgainst + agg.votesAbstain;
  if (totalVotes <= 0) return null;
  return validateDeliberationMajority(requiredMajorityForType(itemType), {
    ...agg,
    totalBuildingPermillage,
  }).approved;
}

// ─── Aggregator (para uso em backfill / debug) ──────────────────────────────

export interface VoteRow {
  vote: AssemblyVoteValue;
  permillageApplied: number;
}

export function aggregateVotes(rows: VoteRow[]): {
  votesInFavor: number;
  votesAgainst: number;
  votesAbstain: number;
} {
  let votesInFavor = 0;
  let votesAgainst = 0;
  let votesAbstain = 0;
  for (const r of rows) {
    if (r.vote === "favor") votesInFavor += r.permillageApplied;
    else if (r.vote === "against") votesAgainst += r.permillageApplied;
    else if (r.vote === "abstain") votesAbstain += r.permillageApplied;
  }
  return { votesInFavor, votesAgainst, votesAbstain };
}
