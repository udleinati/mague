// Fase 3 do pipeline: por recipient ativo (ou escolhido), ensurePortalAccess (auto-invite) -> sendEmail com
// PDF anexo -> grava em `email_sent_to`. Best-effort: falhas marcam `status: 'failed'`, nunca
// lançam. Separado do orchestrator (única fase com I/O fora da transação) para ser retried
// por `resend_email.ts` sem replicar a lógica.

import { eq } from "drizzle-orm";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import type { EmailSendRecord, IssuedByActor } from "$api/libs/postgres/schemas/receipt.ts";
import { formatDate, formatMoney } from "$api/libs/templates/render.ts";
import { getObject } from "$api/libs/storage/s3.ts";
import { receiptIssuedEmailHtml, sendEmail } from "$api/libs/email/send.ts";
import { portalReceiptUrl } from "./urls.ts";
import { ensurePortalAccess } from "$api/modules/auth/portal_access.ts";
import type { SnapshotsBundle } from "./_shared.ts";
import { shouldEmailRecipient } from "./recipients.ts";

interface NotifyRecipientsInput {
  receipt: typeof schema.receipt.$inferSelect;
  snapshots: SnapshotsBundle;
  panelBaseUrl: string;
  actor: IssuedByActor;
}

interface NotifyRecipientsResult {
  emailsSent: number;
  emailsFailed: number;
  records: EmailSendRecord[];
}

export async function notifyRecipients(
  postgres: Postgres,
  input: NotifyRecipientsInput,
): Promise<NotifyRecipientsResult> {
  const { receipt, snapshots, panelBaseUrl, actor } = input;
  const condominiumId = receipt.condominiumId;
  const unitId = receipt.unitId;

  // BCC + Reply-To resolvidos pelo `sendEmail` a partir do `condominiumId`; sem lookup aqui.

  // PDF re-fetch do S3 - uma vez, partilhado por todos os recipients.
  const attachmentBytes = await getObject(receipt.storageKey);
  const attachmentName = `recibo-${(receipt.number ?? "").replace("/", "-")}.pdf`;

  let emailsSent = 0;
  let emailsFailed = 0;
  const records: EmailSendRecord[] = [];

  for (const recipient of snapshots.recipientsLive) {
    if (!recipient.email || !shouldEmailRecipient(recipient, recipient.receiveEmails)) continue;
    try {
      // Destinatário manual (sem ocupante): sem convite nem link do portal, só o PDF.
      let receiptUrl: string | undefined;
      if (recipient.occupantId) {
        const portalUrl = portalReceiptUrl(panelBaseUrl, condominiumId, unitId, receipt.id);
        const access = await ensurePortalAccess({
          postgres,
          occupant: {
            id: recipient.occupantId,
            userId: recipient.userId,
            email: recipient.email,
            name: recipient.name,
          },
          directUrl: portalUrl,
          panelBaseUrl,
          condominium: {
            id: condominiumId,
            name: snapshots.condominium.name,
            designationType: snapshots.condominium.designationType,
          },
          // Auto-invite via receipt é system-driven side-effect (não é o admin
          // a criar o convite - é a app a propagar). Actor `null` faz o
          // invite_token ficar com `created_by = '{}'`.
          actor: null,
        });
        if (access.inviteSkipped) {
          console.warn(
            `[receipt:${receipt.id}] auto-invite skipped for ${recipient.email}: ${access.inviteSkipped}`,
          );
        }
        receiptUrl = access.linkUrl;
      }
      const receiptNumber = receipt.number ?? "";
      await sendEmail({
        to: recipient.email,
        subject: `Recibo ${receiptNumber} · ${snapshots.condominium.name}`,
        category: "receipt",
        condominiumId,
        unitId,
        occupantId: recipient.occupantId,
        postgres,
        actor,
        html: receiptIssuedEmailHtml({
          recipientName: recipient.name,
          condominiumName: snapshots.condominium.name,
          designationType: snapshots.condominium.designationType ?? "condominium",
          unitDesignation: snapshots.unit.designation,
          unitIdentifier: snapshots.unit.identifier,
          receiptNumber,
          amount: formatMoney(receipt.amountCents),
          paymentDate: formatDate(snapshots.bankTx.transactionDate),
          receiptUrl,
        }),
        attachments: [
          { filename: attachmentName, content: attachmentBytes, contentType: "application/pdf" },
        ],
      });
      emailsSent++;
      records.push({
        email: recipient.email,
        sentAt: new Date().toISOString(),
        status: "sent",
      });
    } catch (e) {
      emailsFailed++;
      records.push({
        email: recipient.email,
        sentAt: new Date().toISOString(),
        status: "failed",
        error: (e as Error).message,
      });
    }
  }

  if (records.length > 0) {
    await postgres.query((db) =>
      db.update(schema.receipt)
        .set({
          emailSentTo: records,
          emailLastAttemptAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.receipt.id, receipt.id))
    );
  }

  return { emailsSent, emailsFailed, records };
}
