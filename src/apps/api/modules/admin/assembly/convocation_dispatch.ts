// Planeador do envio da convocatória - ponto único de decisão "dono vs residente" (ADR 0034).
// Puro (sem DB/Chromium/rede): por destinatário decide assunto, procuração e ramo do email;
// `convocation_send.ts` só renderiza e despacha. WHY das duas regras (Rule 9, Art. 1431.º nº 5 CC):
//   • PROPRIETÁRIO (mandante, tem voto) -> procuração personalizada (nome + NIF/NIPC + fração).
//   • RESIDENTE (não vota) -> procuração em branco; pré-preenchê-la seria juridicamente inválida.
//     Sai em branco para um dono a assinar; o email identifica esse(s) dono(s).

import type { ConvocationRecipient, PersonType } from "./convocation_recipients.ts";

/** Conteúdo da procuração decidido para um destinatário. */
export type ProxyPlan =
  | {
    mode: "personalized";
    name: string;
    /** Rótulo fiscal a imprimir: NIPC (coletiva) ou NIF (singular). */
    nifLabel: "NIF" | "NIPC";
    /** NIF/NIPC do registo, ou null (linha em branco para escrever à mão). */
    nif: string | null;
    unitLabel: string;
    personType: PersonType;
  }
  | { mode: "blank" };

/** Ramo do email decidido para um destinatário. O owner traz a natureza
 *  jurídica - o email de uma sociedade (coletiva) é redigido para a empresa. */
export type EmailPlan =
  | { role: "owner"; personType: PersonType }
  | { role: "resident"; ownerNames: string[] };

/** Plano completo de despacho de UM destinatário (assunto + procuração + email). */
export interface ConvocationDispatchPlan {
  /** Assunto do email: tipo + data da assembleia + fração (`unitLabel`) + condomínio. */
  subject: string;
  proxy: ProxyPlan;
  email: EmailPlan;
  /** Email da administração para a nota de correção (ou null). */
  correctionEmail: string | null;
}

/**
 * Decide, por destinatário, o conteúdo da procuração e do email. Puro: a mesma
 * entrada dá sempre a mesma saída. O `unitLabel` ("designation - identifier") e
 * o `correctionEmail` (`replyToEmail ?? email` do condomínio) chegam já
 * resolvidos pelo caller.
 */
export function planConvocationDispatch(
  recipient: ConvocationRecipient,
  ctx: {
    unitLabel: string;
    condominiumName: string;
    correctionEmail: string | null;
    /** Tipo da assembleia - entra no assunto (ordinária vs extraordinária). */
    assemblyType: "ordinary" | "extraordinary";
    /** 1ª convocatória já formatada (data + hora PT-PT) - entra no assunto. */
    firstConvocation: string;
  },
): ConvocationDispatchPlan {
  const tipo = ctx.assemblyType === "ordinary" ? "ordinária" : "extraordinária";
  const subject =
    `Convocatória - Assembleia ${tipo} de condóminos - ${ctx.firstConvocation} - Fração ${ctx.unitLabel} - ${ctx.condominiumName}`;

  if (recipient.relationshipType === "owner") {
    return {
      subject,
      proxy: {
        mode: "personalized",
        name: recipient.name,
        nifLabel: recipient.personType === "collective" ? "NIPC" : "NIF",
        nif: recipient.nif,
        unitLabel: ctx.unitLabel,
        personType: recipient.personType,
      },
      email: { role: "owner", personType: recipient.personType },
      correctionEmail: ctx.correctionEmail,
    };
  }

  // Residente: procuração em branco; o email lista os donos (com voto) da fração.
  return {
    subject,
    proxy: { mode: "blank" },
    email: { role: "resident", ownerNames: recipient.ownerNamesOfUnit },
    correctionEmail: ctx.correctionEmail,
  };
}
