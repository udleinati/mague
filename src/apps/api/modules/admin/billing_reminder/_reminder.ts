// Orchestrator do envio de lembrete de cobrança (ADR 0028, espelha
// `insurance/_reminder.ts`): resolveBillingRecipients (occupants elegíveis),
// dispatchOneBillingEmail (1 email, sent/failed), recordBillingReminderRun (audit).

import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import type { BillingReminderRecipient } from "$api/libs/postgres/schemas/mod.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import {
  billingReminderEmailHtml,
  type BillingReminderEmailLine,
  type BillingReminderEmailPlan,
  sendEmail,
} from "$api/libs/email/send.ts";
import { resolveUnitEmailRecipients, type UnitEmailRecipient } from "$api/libs/email/recipients.ts";

/** Recipient elegível para o lembrete de cobrança (alias do shape partilhado). */
export type EligibleBillingRecipient = UnitEmailRecipient;

/** Wrapper fino sobre `resolveUnitEmailRecipients`. ADR 0028: owners + residents
 *  só, tenants excluídos (Art. 1424 CC). Atira `MISSING_EMAIL` (422) se ninguém
 *  qualifica. */
export function resolveBillingRecipients(
  postgres: Postgres,
  args: { condominiumId: string; unitId: string },
): Promise<EligibleBillingRecipient[]> {
  return resolveUnitEmailRecipients(postgres, {
    condominiumId: args.condominiumId,
    unitId: args.unitId,
    relationshipTypes: ["owner", "resident"],
    missingEmailMessage: (designation) =>
      `Fração ${designation} não tem ocupantes elegíveis (owner/resident) com email registado.`,
  });
}

/** Em plano o assunto não fala de "atraso": o acordo está em curso (ADR 0039). */
export function billingReminderSubject(
  args: { condoName: string; unitLabel: string; inPaymentPlan: boolean },
): string {
  return args.inPaymentPlan
    ? `Plano de pagamento: valores pendentes - ${args.condoName}, fração ${args.unitLabel}`
    : `Quotas em atraso - ${args.condoName}, fração ${args.unitLabel}`;
}

/** Envia 1 email para 1 recipient. Devolve o shape `BillingReminderRecipient`
 *  com `status: "sent" | "failed"` - falha de envio NÃO atira (caller continua
 *  para os próximos). */
export async function dispatchOneBillingEmail(
  postgres: Postgres,
  args: {
    recipient: EligibleBillingRecipient;
    condominiumId: string;
    unitId: string;
    totalOwedCents: number;
    creditCents: number;
    iban: string | null;
    adminNote: string | null;
    lines: BillingReminderEmailLine[];
    paymentPlan: BillingReminderEmailPlan | null;
    actor: ActorSnapshot;
  },
): Promise<BillingReminderRecipient> {
  const { recipient: r, condominiumId, unitId, actor } = args;
  try {
    await sendEmail({
      to: r.email,
      subject: billingReminderSubject({
        condoName: r.condoName,
        unitLabel: r.unitLabel,
        inPaymentPlan: args.paymentPlan !== null,
      }),
      category: "billing_reminder",
      condominiumId,
      unitId,
      occupantId: r.occupantId,
      postgres,
      actor,
      html: billingReminderEmailHtml({
        recipientName: r.name,
        condominiumName: r.condoName,
        designationType: r.condoDesignationType,
        unitDesignation: r.unitLabel,
        totalOwedCents: args.totalOwedCents,
        creditCents: args.creditCents,
        iban: args.iban,
        adminNote: args.adminNote ?? undefined,
        lines: args.lines,
        paymentPlan: args.paymentPlan,
      }),
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

/** Persiste a row em `core.billing_reminder`. Sempre regista, mesmo com 0
 *  recipients (audit "tentei e ninguém qualificou" - útil para diagnose). */
export async function recordBillingReminderRun(
  postgres: Postgres,
  args: {
    condominiumId: string;
    unitId: string;
    trigger: "individual" | "bulk";
    recipients: BillingReminderRecipient[];
    actor: ActorSnapshot;
  },
): Promise<void> {
  await postgres.query((db) =>
    db.insert(schema.billingReminder).values({
      condominiumId: args.condominiumId,
      unitId: args.unitId,
      trigger: args.trigger,
      recipients: args.recipients,
      sentBy: args.actor,
    })
  );
}
