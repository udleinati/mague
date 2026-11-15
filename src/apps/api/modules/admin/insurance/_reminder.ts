// Envio de lembretes de seguro, 3 funções injectáveis em testes:
//   resolveReminderRecipients - lookup DB -> occupants elegíveis.
//   dispatchOneReminder       - envia 1 email, devolve {status, sentAt}.
//   recordReminderRun         - INSERT na tabela de audit.
// Orchestrator (`sendReminderForUnit` em `reminder.ts`) chama os 3 por ordem.
// `sendAdminEvidenceNotice` (no fim) está fora deste trio de propósito - ver lá.

import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import type { InsuranceReminderRecipient } from "$api/libs/postgres/schemas/mod.ts";
import {
  insuranceAdminEvidenceEmailHtml,
  insuranceReminderEmailHtml,
  insuranceRenewalEvidenceEmailHtml,
  sendEmail,
} from "$api/libs/email/send.ts";
import { resolveUnitEmailRecipients, type UnitEmailRecipient } from "$api/libs/email/recipients.ts";
import { formatDate } from "$api/libs/templates/render.ts";

// Alias do shape partilhado. Seguro inclui todos os ocupantes ativos com email
// (sem filtro de relationship_type, ao contrário da cobrança).
export type EligibleRecipient = UnitEmailRecipient;

// Wrapper fino sobre `resolveUnitEmailRecipients`: seguro não restringe por
// relationship_type. Atira MISSING_EMAIL (422) se ninguém qualifica.
export function resolveReminderRecipients(
  postgres: Postgres,
  args: { condominiumId: string; unitId: string },
): Promise<EligibleRecipient[]> {
  return resolveUnitEmailRecipients(postgres, {
    condominiumId: args.condominiumId,
    unitId: args.unitId,
    missingEmailMessage: (designation) =>
      `Fração ${designation} não tem nenhum occupant com email registado - adiciona um email antes de enviar o lembrete.`,
  });
}

/** Parâmetros comuns aos dois emails de seguro. */
export interface InsuranceEmailParams {
  recipientName: string;
  condominiumName: string;
  designationType: "building" | "condominium";
  unitDesignation: string;
  portalUrl: string;
  adminNote?: string;
}

/** O trigger escolhe o email: falta o seguro vs falta o comprovativo da
 *  renovação. Fonte única do envio e da pré-visualização. */
export function insuranceReminderHtmlFor(
  trigger: "individual" | "bulk" | "renewal_evidence",
  params: InsuranceEmailParams,
): string {
  return trigger === "renewal_evidence"
    ? insuranceRenewalEvidenceEmailHtml(params)
    : insuranceReminderEmailHtml(params);
}

/** Assunto pelo mesmo trigger do corpo - fonte única do envio e da pré-visualização. */
export function insuranceReminderSubject(
  trigger: "individual" | "bulk" | "renewal_evidence",
  args: { condoName: string; unitLabel: string },
): string {
  return trigger === "renewal_evidence"
    ? `Renovação de seguro - envie o comprovativo (${args.condoName}, fração ${args.unitLabel})`
    : `Seguro em falta - ${args.condoName}, fração ${args.unitLabel}`;
}

// Não lança em falha de envio: converte para `status: "failed"` para o
// orchestrator continuar com os próximos recipients.
export async function dispatchOneReminder(
  postgres: Postgres,
  args: {
    recipient: EligibleRecipient;
    condominiumId: string;
    unitId: string;
    panelBaseUrl: string;
    /** 'renewal_evidence' troca o copy para o email de renovação. */
    trigger: "individual" | "bulk" | "renewal_evidence";
    actor: ActorSnapshot;
    /** Nota livre da administração no topo do email (condominium-wide). */
    adminNote?: string | null;
  },
): Promise<InsuranceReminderRecipient> {
  const { recipient: r, condominiumId, unitId, panelBaseUrl, actor } = args;
  const portalUrl = `${panelBaseUrl}/portal/c/${condominiumId}/u/${unitId}/insurances`;
  const emailParams = {
    recipientName: r.name,
    condominiumName: r.condoName,
    designationType: r.condoDesignationType,
    unitDesignation: r.unitLabel,
    portalUrl,
    adminNote: args.adminNote ?? undefined,
  };
  const subject = insuranceReminderSubject(args.trigger, {
    condoName: r.condoName,
    unitLabel: r.unitLabel,
  });
  try {
    // BCC + Reply-To resolvidos pelo `sendEmail` a partir de condominiumId.
    await sendEmail({
      to: r.email,
      subject,
      category: "insurance_reminder",
      condominiumId,
      unitId,
      occupantId: r.occupantId,
      postgres,
      actor,
      html: insuranceReminderHtmlFor(args.trigger, emailParams),
    });
    return {
      occupantId: r.occupantId,
      email: r.email,
      name: r.name,
      status: "sent",
      sentAt: new Date().toISOString(),
    };
  } catch (e) {
    return {
      occupantId: r.occupantId,
      email: r.email,
      name: r.name,
      status: "failed",
      sentAt: new Date().toISOString(),
      error: (e as Error).message,
    };
  }
}

// Nota livre da administração (condominium-wide) para o topo do email.
// null/vazio = email sem caixa. Espelha o billing (loadBillingEmailContext).
export async function loadInsuranceReminderNote(
  postgres: Postgres,
  condominiumId: string,
): Promise<string | null> {
  return await postgres.query((db) =>
    db.query.condominium.findFirst({
      where: (cnd, ops) => ops.eq(cnd.id, condominiumId),
      columns: { insuranceReminderNote: true },
    })
  ).then((r) => r?.insuranceReminderNote ?? null);
}

/**
 * Avisa a fração de que a administração registou a apólice com o documento que
 * lhe foi entregue (ADR 0016). Fora da família dos lembretes de
 * propósito: não pede nada, logo não tem cooldown nem entra em
 * `core.insurance_reminder` (que audita pedidos). O rasto fica em
 * `audit.email_log` pela categoria própria.
 *
 * É o controlo que substitui a evidência submetida pela própria fração: a
 * pessoa afetada por um registo que não passou por ela fica a saber dele.
 */
export async function sendAdminEvidenceNotice(
  postgres: Postgres,
  args: {
    condominiumId: string;
    unitId: string;
    panelBaseUrl: string;
    /** Vigência aprovada; `renewedFromId` distingue renovação de 1º registo. */
    policy: { validFrom: string; validTo: string; renewedFromId: string | null };
    actor: ActorSnapshot;
  },
): Promise<void> {
  const recipients = await resolveReminderRecipients(postgres, {
    condominiumId: args.condominiumId,
    unitId: args.unitId,
  });
  const portalUrl =
    `${args.panelBaseUrl}/portal/c/${args.condominiumId}/u/${args.unitId}/insurances`;
  for (const r of recipients) {
    try {
      await sendEmail({
        to: r.email,
        subject: `Seguro registado pela administração (${r.condoName}, fração ${r.unitLabel})`,
        category: "insurance_admin_evidence",
        condominiumId: args.condominiumId,
        unitId: args.unitId,
        occupantId: r.occupantId,
        postgres,
        actor: args.actor,
        html: insuranceAdminEvidenceEmailHtml({
          recipientName: r.name,
          condominiumName: r.condoName,
          designationType: r.condoDesignationType,
          unitDesignation: r.unitLabel,
          validFrom: formatDate(args.policy.validFrom),
          validTo: formatDate(args.policy.validTo),
          renewal: args.policy.renewedFromId !== null,
          portalUrl,
        }),
      });
    } catch (e) {
      // Um destinatário sem caixa não pode calar os outros. O `email_log` já
      // guardou o `failed`; aqui fica o rasto de que houve falha.
      console.warn(
        `[insurance] aviso de registo falhou (occupant ${r.occupantId}):`,
        (e as Error).message,
      );
    }
  }
}

// Regista mesmo com 0 recipients (auditoria de "tentei e ninguém qualificou").
export async function recordReminderRun(
  postgres: Postgres,
  args: {
    condominiumId: string;
    unitId: string;
    trigger: "individual" | "bulk" | "renewal_evidence";
    recipients: InsuranceReminderRecipient[];
    actor: ActorSnapshot;
  },
): Promise<void> {
  await postgres.query((db) =>
    db.insert(schema.insuranceReminder).values({
      condominiumId: args.condominiumId,
      unitId: args.unitId,
      trigger: args.trigger,
      recipients: args.recipients,
      sentBy: args.actor,
    })
  );
}
