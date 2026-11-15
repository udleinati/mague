// Copy e tom do estado de um seguro - fonte única do par (label, tone) que os
// templates mostram. Antes eram cinco escadas `kind → label` escritas à mão
// (admin/fração, admin/apólice, portal/lista, portal/detalhe, histórico da
// fração), com vocabulário divergente e uma delas já stale face ao
// `evidence_source`. O `kind` continua a ser decidido no domínio
// ($shared/insurance/policy_status.ts); aqui só se traduz para PT-PT.
//
// As classes Tailwind NÃO saem daqui: o JIT só vê literais, por isso o mapa
// tone → classes vive em `partials/status_badge.vto` (ADR 0036).

import type { BadgeTone, StatusBadgeProps } from "./charge_status.ts";
import { RENEW_MAX_OVERDUE_DAYS } from "$shared/insurance/policy_status.ts";

/**
 * Quem está a ler e sobre o quê:
 * - `unit`   - a administração a olhar para o estado da FRAÇÃO (masculino).
 * - `policy` - a administração a olhar para uma APÓLICE (feminino).
 * - `portal` - a fração a olhar para a sua própria apólice. Vocabulário
 *   diferente de propósito: "Em revisão"/"Por confirmar" dizem-lhe o que se
 *   passa do lado dela, "Aguarda aprovação" descreve a fila do admin.
 */
export type InsuranceStatusVoice = "unit" | "policy" | "portal";

const LABELS: Record<InsuranceStatusVoice, Record<string, string>> = {
  unit: {
    active: "Ativo",
    expiring_soon: "A expirar",
    expired: "Vencido",
    awaiting_approval: "Aguarda aprovação",
    awaiting_confirmation: "Aguarda condómino",
    rejected_only: "Rejeitado",
    superseded: "Substituído",
    never_submitted: "Sem submissão",
  },
  policy: {
    active: "Ativa",
    expiring_soon: "A expirar",
    expired: "Vencida",
    awaiting_approval: "Aguarda aprovação",
    awaiting_confirmation: "Aguarda condómino",
    rejected_only: "Rejeitada",
    superseded: "Substituída",
    never_submitted: "Sem submissão",
  },
  portal: {
    active: "Ativa",
    expiring_soon: "A expirar",
    expired: "Vencida",
    awaiting_approval: "Em revisão",
    awaiting_confirmation: "Por confirmar",
    rejected_only: "Rejeitada",
    superseded: "Substituída",
    never_submitted: "Sem submissão",
  },
};

// Tons por voz. Duas divergências deliberadas face ao `policy`:
// - `rejected_only` na voz `unit` é `muted`, não `error`: ao nível da fração o
//   que interessa é "não está coberta" (igual a never_submitted); o vermelho
//   fica para a apólice concreta que foi recusada.
// - `awaiting_confirmation` no portal é `warning`, não `muted`: ali é uma
//   pendência da própria fração, não informação passiva.
const TONES: Record<InsuranceStatusVoice, Record<string, BadgeTone>> = {
  unit: {
    active: "success",
    expiring_soon: "warning",
    expired: "error",
    awaiting_approval: "info",
    awaiting_confirmation: "muted",
    rejected_only: "muted",
    superseded: "muted",
    never_submitted: "neutral",
  },
  policy: {
    active: "success",
    expiring_soon: "warning",
    expired: "error",
    awaiting_approval: "info",
    awaiting_confirmation: "muted",
    rejected_only: "error",
    superseded: "muted",
    never_submitted: "neutral",
  },
  portal: {
    active: "success",
    expiring_soon: "warning",
    expired: "error",
    awaiting_approval: "info",
    awaiting_confirmation: "warning",
    rejected_only: "error",
    superseded: "muted",
    never_submitted: "neutral",
  },
};

/**
 * `kind` (do domínio) -> `{ label, tone }` para `partials/status_badge.vto`.
 * `kind` desconhecido cai em `never_submitted`: um estado novo aparece como
 * "Sem submissão" em vez de deixar a célula vazia como as escadas faziam.
 */
export function insuranceStatusBadge(
  kind: string | null | undefined,
  voice: InsuranceStatusVoice = "policy",
): StatusBadgeProps {
  const k = kind ?? "never_submitted";
  return {
    label: LABELS[voice][k] ?? LABELS[voice].never_submitted,
    tone: TONES[voice][k] ?? "neutral",
  };
}

// ─── Hero do portal ─────────────────────────────────────────────────────────
// O título grande da página de seguro da fração e o botão por baixo dele. Vivia
// como uma escada de 8 ramos no `index.vto`, que reescrevia estas mesmas
// palavras e discordava dos tons daqui (dava `info` ao "por confirmar" que este
// módulo marca `warning`). O `kind` continua a vir do domínio; a decisão de
// "renovar ou submeter" é a mesma que o gate `presumedAt` já exprimia.

/** Estado agregado da fração, como o portal o recebe da API. */
export interface InsuranceHeroState {
  kind?: string | null;
  daysOverdue?: number;
  daysUntilExpiry?: number;
  policy?: { id?: string; presumedAt?: string | Date | null } | null;
}

export interface InsuranceHero {
  /** Normalizado: `never_submitted` quando não há estado nenhum. */
  kind: string;
  /** Título partido para o destaque a cor ficar num `<span>` só. */
  prefix: string;
  highlight: string;
  suffix: string;
  tone: BadgeTone;
  /** Renovação sem comprovativo: o CTA aponta ao detalhe, não a nova submissão. */
  presumedPending: boolean;
  cta: {
    label: string;
    /** `detail` e `renew` precisam do `policy.id`; `upload` é a submissão de
     *  raiz (contrato novo, sem predecessor de onde herdar). */
    target: "detail" | "upload" | "renew";
  };
}

/** Espelha o `canRenew` do domínio a partir do agregado, que é o que o hero
 *  tem à mão (não a apólice inteira). */
function renewableKind(kind: string, daysOverdue: number): boolean {
  if (kind === "active" || kind === "expiring_soon") return true;
  return kind === "expired" && daysOverdue <= RENEW_MAX_OVERDUE_DAYS;
}

export function insuranceHero(state: InsuranceHeroState | null | undefined): InsuranceHero {
  const kind = state?.kind ?? "never_submitted";
  const presumedPending = kind === "active" && !!state?.policy?.presumedAt;

  const cta: InsuranceHero["cta"] = presumedPending
    // Empurrar "Submeter renovação" aqui criava uma apólice nova por cima da
    // presumida; o comprovativo anexa-se à que já existe.
    ? { label: "Enviar comprovativo", target: "detail" }
    // Há apólice de onde renovar: o formulário herda-lhe os dados em vez de
    // pedir tudo de novo. Sem `policy.id` não há predecessor - cai no upload.
    // A janela é a do `canRenew`, senão o hero manda submeter de raiz uma
    // apólice que o detalhe ainda deixa renovar.
    : renewableKind(kind, state?.daysOverdue ?? 0) && state?.policy?.id
    ? { label: "Renovar apólice", target: "renew" }
    : { label: "Submeter apólice", target: "upload" };

  const base = { kind, presumedPending, cta };

  if (presumedPending) {
    return {
      ...base,
      prefix: "Apólice renovada - ",
      highlight: "falta o comprovativo",
      suffix: "",
      tone: "warning",
    };
  }
  switch (kind) {
    case "never_submitted":
      return {
        ...base,
        prefix: "Ainda ",
        highlight: "sem apólice",
        suffix: " submetida",
        tone: "error",
      };
    case "expired":
      return {
        ...base,
        prefix: "Apólice ",
        highlight: `vencida há ${state?.daysOverdue ?? 0} dias`,
        suffix: "",
        tone: "error",
      };
    case "expiring_soon":
      return {
        ...base,
        prefix: "Apólice ",
        highlight: `expira em ${state?.daysUntilExpiry ?? 0} dias`,
        suffix: "",
        tone: "warning",
      };
    case "rejected_only":
      return {
        ...base,
        prefix: "Última apólice ",
        highlight: "rejeitada",
        suffix: "",
        tone: "error",
      };
    case "awaiting_confirmation":
      // `warning` e não `info`: é uma pendência da própria fração (ver TONES).
      return {
        ...base,
        prefix: "Apólice ",
        highlight: "por confirmar",
        suffix: "",
        tone: "warning",
      };
    case "awaiting_approval":
      return {
        ...base,
        prefix: "Apólice ",
        highlight: "em revisão",
        suffix: " pelo administrador",
        tone: "info",
      };
    case "superseded":
      // O agregado nunca devolve `superseded` (uma fração só com substituídas lê
      // -se `never_submitted`). Explícito na mesma, para não cair no "válida ✓".
      return { ...base, prefix: "Apólice ", highlight: "substituída", suffix: "", tone: "muted" };
    case "active":
      return { ...base, prefix: "Apólice válida ", highlight: "✓", suffix: "", tone: "success" };
    default:
      // Kind novo degrada como no badge: lê-se "sem apólice", nunca vazio.
      return {
        ...base,
        kind: "never_submitted",
        prefix: "Ainda ",
        highlight: "sem apólice",
        suffix: " submetida",
        tone: "error",
      };
  }
}

/**
 * Renovação presumida ainda à espera do recibo anual. Mesma regra que o
 * `presumedEvidenceGap` do domínio (`status` cru = `active`, com `presumedAt` e
 * zero anexos). O detalhe do portal recompunha-a com `kind !== "superseded"`, o
 * que deixava passar uma apólice rejeitada.
 */
export function insurancePresumedPending(
  policy: { status?: string | null; presumedAt?: string | Date | null } | null | undefined,
  attachmentCount: number,
): boolean {
  return policy?.status === "active" && !!policy?.presumedAt && attachmentCount === 0;
}
