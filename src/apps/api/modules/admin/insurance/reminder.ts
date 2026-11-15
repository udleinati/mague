// Orchestrator do envio de lembretes (thin wrapper). Trabalho granular em
// `_reminder.ts`: resolve recipients, dispatch de cada email, record da run.

import type { Postgres } from "$api/libs/postgres/postgres.ts";
import type { ActorSnapshot } from "$api/libs/postgres/schemas/_audit.ts";
import type { InsuranceReminderRecipient } from "$api/libs/postgres/schemas/mod.ts";

// Envia lembrete a todos os occupants elegíveis de uma fração:
// resolveReminderRecipients -> loop dispatchOneReminder -> recordReminderRun.
export async function sendReminderForUnit(
  postgres: Postgres,
  args: {
    condominiumId: string;
    unitId: string;
    trigger: "individual" | "bulk" | "renewal_evidence";
    actor: ActorSnapshot;
    panelBaseUrl: string;
  },
): Promise<{ sent: number; failed: number; recipients: InsuranceReminderRecipient[] }> {
  const {
    resolveReminderRecipients,
    dispatchOneReminder,
    recordReminderRun,
    loadInsuranceReminderNote,
  } = await import("./_reminder.ts");
  const eligible = await resolveReminderRecipients(postgres, {
    condominiumId: args.condominiumId,
    unitId: args.unitId,
  });
  // Nota da administração (1 lookup por fração; em bulk repete-se mas o overhead
  // é aceitável - mesma frequência baixa que o billing).
  const adminNote = await loadInsuranceReminderNote(postgres, args.condominiumId);
  // BCC + Reply-To resolvidos pelo `sendEmail`; 1 lookup por email (overhead
  // aceitável dada a baixa frequência de bulk reminders).
  const recipients: InsuranceReminderRecipient[] = [];
  for (const recipient of eligible) {
    const result = await dispatchOneReminder(postgres, {
      recipient,
      condominiumId: args.condominiumId,
      unitId: args.unitId,
      panelBaseUrl: args.panelBaseUrl,
      trigger: args.trigger,
      actor: args.actor,
      adminNote,
    });
    recipients.push(result);
  }
  await recordReminderRun(postgres, {
    condominiumId: args.condominiumId,
    unitId: args.unitId,
    trigger: args.trigger,
    recipients,
    actor: args.actor,
  });
  const sent = recipients.filter((r) => r.status === "sent").length;
  const failed = recipients.filter((r) => r.status === "failed").length;
  return { sent, failed, recipients };
}
