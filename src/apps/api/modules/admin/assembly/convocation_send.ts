// Orquestração do envio da convocatória, por fração (ADR 0034) + 2 anexos PDF. Render da
// convocatória UMA vez (Chromium); por destinatário com email render da procuração
// personalizada + envio dos 2 anexos; sem email -> "failed" (nunca saltado calado). Cada
// envio grava 1 row em `core.assembly_convocation`; `convocation_sent_at` no 1º com >=1 sent.
// Cooldown por (pessoa, fração) (ADR 0032): reenvio individual -> 422; bulk salta e conta em
// `skippedCooldown`. Reenviar a fração A não mexe na janela da B.

import { STATUS_CODE } from "@std/http";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import type { AssemblyConvocationRecipient } from "$api/libs/postgres/schemas/mod.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import { formatDateTime, renderTemplate } from "$api/libs/templates/render.ts";
import { renderPdf } from "$api/libs/pdf/render.ts";
import { assemblyConvocationEmailHtml, sendEmail } from "$api/libs/email/send.ts";
import {
  buildConvocationSnapshot,
  type ConvocationSnapshot,
} from "$shared/assembly/convocation_snapshot.ts";
import {
  convocationCooldownEndsAt,
  isInConvocationCooldown,
} from "$shared/assembly/convocation_eligibility.ts";
import { formatRemaining } from "$shared/time/remaining.ts";
import { unitLabel } from "$shared/labels/mod.ts";
import type { ConvocationContext } from "./convocation_pdf.ts";
import {
  type ConvocationRecipient,
  recipientKey,
  resolveConvocationRecipients,
} from "./convocation_recipients.ts";
import { type ConvocationDispatchPlan, planConvocationDispatch } from "./convocation_dispatch.ts";
import { loadLastConvocationSentAt } from "./convocation_history.ts";

export interface ConvocationSendResult {
  totalRecipients: number;
  /** Emails entregues com sucesso. */
  sent: number;
  /** Falhas de transporte (tinham email mas o envio falhou). */
  failed: number;
  /** Destinatários sem email registado (status failed, mas razão distinta). */
  noEmail: number;
  /** Destinatários saltados por estarem em cooldown (só no bulk). */
  skippedCooldown: number;
  recipients: AssemblyConvocationRecipient[];
}

/** Resumo do email já formatado (datas PT-PT). Calculado uma vez por envio e
 *  partilhado por todos os destinatários. A ordem do dia não entra aqui - vive
 *  na convocatória anexa (PDF), não no corpo do email. */
export interface ConvocationEmailMeta {
  condominiumName: string;
  designationType: "building" | "condominium";
  assemblyType: "ordinary" | "extraordinary";
  firstConvocation: string;
  secondConvocation: string | null;
  location: string | null;
  /** Email da administração para a nota de correção (`replyToEmail ?? email`, ou null). */
  correctionEmail: string | null;
}

// Corpo HTML do email da convocatória para UM destinatário. Ponto único de render
// (Rule 9): envio (`dispatchOneConvocation`) e pré-visualização usam-no, garantindo
// que o "Ver" mostra exatamente o que o destinatário recebe. Puro.
export function renderConvocationEmailHtml(args: {
  recipient: ConvocationRecipient;
  plan: ConvocationDispatchPlan;
  emailMeta: ConvocationEmailMeta;
  portalUrl: string;
}): string {
  const { recipient: r, plan, emailMeta, portalUrl } = args;
  return assemblyConvocationEmailHtml({
    recipientName: r.name,
    condominiumName: emailMeta.condominiumName,
    designationType: emailMeta.designationType,
    assemblyType: emailMeta.assemblyType,
    firstConvocation: emailMeta.firstConvocation,
    secondConvocation: emailMeta.secondConvocation,
    location: emailMeta.location,
    portalUrl,
    recipient: plan.email,
    correctionEmail: plan.correctionEmail,
  });
}

// Envia a 1 destinatário com email (procuração personalizada + 2 anexos). Não atira em
// falha de transporte - converte para `status: "failed"` para o loop continuar.
async function dispatchOneConvocation(
  postgres: Postgres,
  args: {
    recipient: ConvocationRecipient;
    context: ConvocationContext;
    emailMeta: ConvocationEmailMeta;
    condominiumId: string;
    convocationPdf: Uint8Array;
    generatedAt: string;
    panelBaseUrl: string;
    actor: ActorSnapshot;
  },
): Promise<AssemblyConvocationRecipient> {
  const { recipient: r, context, emailMeta, condominiumId, convocationPdf } = args;
  const label = unitLabel({
    id: r.unitId,
    designation: r.unitDesignation,
    identifier: r.unitIdentifier,
  });
  // O planeador (puro) decide tudo o que ramifica por dono/residente: assunto,
  // procuração (personalizada vs em branco) e ramo do email (ADR 0034). Este
  // loop só renderiza e despacha o que ele resolve.
  const plan = planConvocationDispatch(r, {
    unitLabel: label,
    condominiumName: emailMeta.condominiumName,
    correctionEmail: emailMeta.correctionEmail,
    assemblyType: emailMeta.assemblyType,
    firstConvocation: emailMeta.firstConvocation,
  });
  try {
    const proxyHtml = await renderTemplate("assembly_proxy.vto", {
      condominium: context.condominium,
      assembly: context.assembly,
      recipient: plan.proxy,
      generatedAt: args.generatedAt,
    });
    const proxyPdf = await renderPdf({ html: proxyHtml });

    const portalUrl = `${args.panelBaseUrl}/portal/c/${condominiumId}/u/${r.unitId}/assemblies`;
    await sendEmail({
      to: r.email!,
      subject: plan.subject,
      category: "assembly_convocation",
      condominiumId,
      unitId: r.unitId,
      occupantId: r.occupantId,
      postgres,
      actor: args.actor,
      html: renderConvocationEmailHtml({ recipient: r, plan, emailMeta, portalUrl }),
      attachments: [
        { filename: "convocatoria.pdf", content: convocationPdf, contentType: "application/pdf" },
        { filename: "procuracao.pdf", content: proxyPdf, contentType: "application/pdf" },
      ],
    });
    return {
      occupantId: r.occupantId,
      unitId: r.unitId,
      email: r.email!,
      name: r.name,
      status: "sent",
      sentAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      occupantId: r.occupantId,
      unitId: r.unitId,
      email: r.email ?? "",
      name: r.name,
      status: "failed",
      sentAt: new Date().toISOString(),
      error: (e as Error).message,
    };
  }
}

// 1 row em `core.assembly_convocation`.
async function recordConvocationRun(
  postgres: Postgres,
  args: {
    condominiumId: string;
    assemblyId: string;
    trigger: "individual" | "bulk";
    recipients: AssemblyConvocationRecipient[];
    snapshot: ConvocationSnapshot;
    actor: ActorSnapshot;
  },
): Promise<void> {
  await postgres.query((db) =>
    db.insert(schema.assemblyConvocation).values({
      assemblyId: args.assemblyId,
      condominiumId: args.condominiumId,
      trigger: args.trigger,
      recipients: args.recipients,
      snapshot: args.snapshot,
      sentBy: args.actor,
    })
  );
}

/** Bytes + metadados partilhados por todos os destinatários de um envio. */
interface PreparedConvocation {
  snapshot: ConvocationSnapshot;
  convocationPdf: Uint8Array;
  emailMeta: ConvocationEmailMeta;
}

// Monta o comum a todos os destinatários: snapshot, render da convocatória (Chromium UMA
// vez, bytes reusados) e metadados do email. Partilhado por bulk e individual.
async function prepareConvocationSend(
  postgres: Postgres,
  args: { context: ConvocationContext; condominiumId: string; generatedAt: string },
): Promise<PreparedConvocation> {
  const { context, condominiumId, generatedAt } = args;

  const snapshot = buildConvocationSnapshot(
    context.assembly as Parameters<typeof buildConvocationSnapshot>[0],
    context.agendaItems as Parameters<typeof buildConvocationSnapshot>[1],
  );

  const convocationHtml = await renderTemplate("assembly_convocation.vto", {
    condominium: context.condominium,
    assembly: context.assembly,
    agendaItems: context.agendaItems,
    generatedAt,
  });
  const convocationPdf = await renderPdf({ html: convocationHtml });

  const emailMeta = await buildConvocationEmailMeta(postgres, { context, condominiumId });

  return { snapshot, convocationPdf, emailMeta };
}

// Metadados do email partilhados por todos os destinatários (datas PT-PT, designação,
// nota de correção). Exposto para a pré-visualização reusar exatamente os mesmos dados.
export async function buildConvocationEmailMeta(
  postgres: Postgres,
  args: { context: ConvocationContext; condominiumId: string },
): Promise<ConvocationEmailMeta> {
  const a = args.context.assembly as Record<string, unknown>;
  return {
    condominiumName: args.context.condominium.name,
    designationType: await resolveDesignationType(postgres, args.condominiumId),
    assemblyType: a.type === "ordinary" ? "ordinary" : "extraordinary",
    firstConvocation: formatDateTime(a.scheduledAt),
    secondConvocation: a.secondConvocationAt ? formatDateTime(a.secondConvocationAt) : null,
    location: (a.location as string | null) ?? null,
    correctionEmail: args.context.correctionEmail,
  };
}

// Data oficial de envio no 1º com >=1 sent; idempotente (não sobrescreve). Bulk e individual.
async function markConvocationSentAt(
  postgres: Postgres,
  args: { a: Record<string, unknown>; sent: number; assemblyId: string; condominiumId: string },
): Promise<void> {
  if (args.sent > 0 && !args.a.convocationSentAt) {
    await postgres.query((db) =>
      db.update(schema.assembly)
        .set({ convocationSentAt: new Date() })
        .where(byIdInCondo(schema.assembly, args.assemblyId, args.condominiumId))
    );
  }
}

// Envia a todos os elegíveis (owner+resident de todas as frações). Salta quem está em
// cooldown (ADR 0032), contando em `skippedCooldown`. O caller garante a assembleia
// não-`draft` antes de chamar.
export async function sendConvocationBulk(
  postgres: Postgres,
  args: {
    context: ConvocationContext;
    condominiumId: string;
    assemblyId: string;
    trigger: "individual" | "bulk";
    actor: ActorSnapshot;
    panelBaseUrl: string;
  },
): Promise<ConvocationSendResult> {
  const { context, condominiumId, assemblyId, trigger, actor, panelBaseUrl } = args;
  const a = context.assembly as Record<string, unknown>;
  const generatedAt = new Date().toISOString();
  const now = new Date();

  const recipients = await resolveConvocationRecipients(postgres, { condominiumId });
  const lastSentByRecipient = await loadLastConvocationSentAt(postgres, {
    condominiumId,
    assemblyId,
  });

  // Partição: cada (pessoa, fração) em cooldown é saltado (não dispatched, não
  // entra no run). Quem nunca recebeu (incl. sem-email) nunca está em cooldown.
  // O 1º envio salta zero (map vazio).
  const toDispatch: ConvocationRecipient[] = [];
  let skippedCooldown = 0;
  for (const r of recipients) {
    const lastSent = lastSentByRecipient.get(recipientKey(r.occupantId, r.unitId)) ?? null;
    if (isInConvocationCooldown(lastSent, now)) {
      skippedCooldown++;
      continue;
    }
    toDispatch.push(r);
  }

  const { snapshot, convocationPdf, emailMeta } = await prepareConvocationSend(postgres, {
    context,
    condominiumId,
    generatedAt,
  });

  const results: AssemblyConvocationRecipient[] = [];
  for (const r of toDispatch) {
    if (!r.hasEmail) {
      results.push({
        occupantId: r.occupantId,
        unitId: r.unitId,
        email: "",
        name: r.name,
        status: "failed",
        sentAt: new Date().toISOString(),
        error: "Sem email registado",
      });
      continue;
    }
    results.push(
      await dispatchOneConvocation(postgres, {
        recipient: r,
        context,
        emailMeta,
        condominiumId,
        convocationPdf,
        generatedAt,
        panelBaseUrl,
        actor,
      }),
    );
  }

  await recordConvocationRun(postgres, {
    condominiumId,
    assemblyId,
    trigger,
    recipients: results,
    snapshot,
    actor,
  });

  const sent = results.filter((r) => r.status === "sent").length;
  const noEmail = toDispatch.filter((r) => !r.hasEmail).length;
  const failed = results.length - sent - noEmail;

  await markConvocationSentAt(postgres, { a, sent, assemblyId, condominiumId });

  return {
    totalRecipients: recipients.length,
    sent,
    failed,
    noEmail,
    skippedCooldown,
    recipients: results,
  };
}

// Reenvia a UM destinatário, keyed por (pessoa, fração) - não mexe na janela de outra
// fração (ADR 0034). Falha alto (Rule 12): não elegível -> 404; sem email -> 422 NO_EMAIL;
// em cooldown -> 422 COOLDOWN_ACTIVE. O caller garante a assembleia fora de `draft`.
export async function sendConvocationIndividual(
  postgres: Postgres,
  args: {
    context: ConvocationContext;
    condominiumId: string;
    assemblyId: string;
    occupantId: string;
    unitId: string;
    actor: ActorSnapshot;
    panelBaseUrl: string;
  },
): Promise<ConvocationSendResult> {
  const { context, condominiumId, assemblyId, occupantId, unitId, actor, panelBaseUrl } = args;
  const a = context.assembly as Record<string, unknown>;
  const generatedAt = new Date().toISOString();
  const now = new Date();

  const recipients = await resolveConvocationRecipients(postgres, { condominiumId });
  const recipient = recipients.find((r) => r.occupantId === occupantId && r.unitId === unitId);
  if (!recipient) {
    throw new AppError({
      message: "Destinatário não encontrado entre os proprietários e residentes do condomínio.",
      statusCode: STATUS_CODE.NotFound,
      code: "RECIPIENT_NOT_FOUND",
    });
  }
  if (!recipient.hasEmail) {
    throw new AppError({
      message: "Este destinatário não tem email registado.",
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "NO_EMAIL",
    });
  }

  const lastSentByRecipient = await loadLastConvocationSentAt(postgres, {
    condominiumId,
    assemblyId,
  });
  const lastSentAt = lastSentByRecipient.get(recipientKey(occupantId, unitId)) ?? null;
  if (isInConvocationCooldown(lastSentAt, now)) {
    const remaining = formatRemaining(convocationCooldownEndsAt(lastSentAt), now);
    throw new AppError({
      message: `Convocatória já enviada a este destinatário recentemente - ${
        remaining || "aguarda antes de enviar de novo"
      }.`,
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "COOLDOWN_ACTIVE",
    });
  }

  const { snapshot, convocationPdf, emailMeta } = await prepareConvocationSend(postgres, {
    context,
    condominiumId,
    generatedAt,
  });

  const result = await dispatchOneConvocation(postgres, {
    recipient,
    context,
    emailMeta,
    condominiumId,
    convocationPdf,
    generatedAt,
    panelBaseUrl,
    actor,
  });

  await recordConvocationRun(postgres, {
    condominiumId,
    assemblyId,
    trigger: "individual",
    recipients: [result],
    snapshot,
    actor,
  });

  const sent = result.status === "sent" ? 1 : 0;
  await markConvocationSentAt(postgres, { a, sent, assemblyId, condominiumId });

  return {
    totalRecipients: 1,
    sent,
    failed: 1 - sent,
    noEmail: 0,
    skippedCooldown: 0,
    recipients: [result],
  };
}

// Designação (building|condominium) para o cabeçalho do email; o `context.condominium` não a traz.
async function resolveDesignationType(
  postgres: Postgres,
  condominiumId: string,
): Promise<"building" | "condominium"> {
  const row = await postgres.query((db) =>
    db.query.condominium.findFirst({
      where: (c, ops) => ops.eq(c.id, condominiumId),
      columns: { designationType: true },
    })
  );
  return (row?.designationType as "building" | "condominium") ?? "condominium";
}
