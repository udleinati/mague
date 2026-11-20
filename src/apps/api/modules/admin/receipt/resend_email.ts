// POST /v1/admin/condominiums/:cid/receipts/:receiptId/resend-email - re-envia o email do
// recibo aos owners (não regenera o PDF, usa o do S3). Destinatários vêm do snapshot
// (imutável, legal/audit), mas `receive_receipt_emails` é lida no estado ATUAL do occupant
// - opt-in/out alterado depois da emissão vale aqui. O destinatário escolhido recebe sempre.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import { eq } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { findEntityOrFail } from "$api/libs/shared/find_entity.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import { receiptIssuedEmailHtml, sendEmail } from "$api/libs/email/send.ts";
import { getObject } from "$api/libs/storage/s3.ts";
import { requireActor } from "$api/middleware/api_auth.ts";
import { formatDate, formatMoney } from "$api/libs/templates/render.ts";
import { portalReceiptUrl } from "./urls.ts";
import { shouldEmailRecipient } from "./recipients.ts";
import type {
  CondominiumSnapshot,
  EmailSendRecord,
  RecipientSnapshot,
  UnitSnapshot,
} from "$api/libs/postgres/schemas/receipt.ts";

export const resendReceiptEmail = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const receiptId = ctx.req.param("receiptId") ?? "";
  if (!receiptId) {
    throw new AppError({
      message: "receiptId é obrigatório",
      statusCode: STATUS_CODE.BadRequest,
      code: "VALIDATION_ERROR",
    });
  }
  const existingRes = await postgres.query((db) =>
    db.query.receipt.findFirst({
      where: (r, ops) =>
        ops.and(
          ops.eq(r.id, receiptId),
          ops.eq(r.condominiumId, condominiumId),
        ),
    })
  );
  const receipt = findEntityOrFail(existingRes, "Recibo");

  const { safePanelBaseUrl } = await import("$api/libs/shared/panel_base_url.ts");
  const panelBaseUrl = safePanelBaseUrl(ctx);
  const newRecords: EmailSendRecord[] = [];
  let sent = 0;
  let failed = 0;

  const receiptNumber = receipt.number ?? "";
  const condoSnap = receipt.condominiumSnapshot as CondominiumSnapshot;
  const unitSnap = receipt.unitSnapshot as UnitSnapshot;
  // BCC + Reply-To resolvidos pelo `sendEmail`. PDF buscado 1x antes do loop (mesmo p/ todos);
  // falha do S3 propaga - sem PDF não vale a pena re-enviar.
  const pdfBytes = await getObject(receipt.storageKey);
  const pdfFilename = `recibo-${receiptNumber.replace("/", "-")}.pdf`;
  const actor = requireActor(ctx);

  // Preferências atuais dos occupants do snapshot (1 query batch) - honra opt-in/out alterado
  // depois da emissão (ver topo do ficheiro).
  const recipientsSnapshot = (receipt.recipientsSnapshot ?? []) as RecipientSnapshot[];
  const occupantIds = recipientsSnapshot.map((r) => r.occupantId).filter((id) => id !== null);
  const currentOccupants = occupantIds.length === 0
    ? []
    : await postgres.query((db) =>
      db.query.occupant.findMany({
        where: (o, ops) =>
          ops.and(
            ops.inArray(o.id, occupantIds),
            ops.isNull(o.deletedAt),
          ),
        columns: { id: true, receiveReceiptEmails: true },
      })
    );
  const currentReceiveByOccupantId = new Map(
    currentOccupants.map((o) => [o.id, o.receiveReceiptEmails ?? true]),
  );

  for (const recipient of recipientsSnapshot) {
    // Estado ACTUAL do occupant - `undefined` = ocupante eliminado, não envia.
    const currentReceive = recipient.occupantId
      ? currentReceiveByOccupantId.get(recipient.occupantId) === true
      : false;
    if (!recipient.email || !shouldEmailRecipient(recipient, currentReceive)) continue;
    try {
      await sendEmail({
        to: recipient.email,
        subject: `Recibo ${receiptNumber} · ${condoSnap.name} (re-envio)`,
        category: "receipt",
        condominiumId,
        unitId: receipt.unitId,
        occupantId: recipient.occupantId,
        postgres,
        actor,
        html: receiptIssuedEmailHtml({
          recipientName: recipient.name,
          condominiumName: condoSnap.name,
          designationType: condoSnap.designationType ?? "condominium",
          unitDesignation: unitSnap.designation,
          unitIdentifier: unitSnap.identifier,
          receiptNumber,
          amount: formatMoney(receipt.amountCents),
          paymentDate: formatDate(
            (receipt.bankTxSnapshot as { transactionDate: string }).transactionDate,
          ),
          receiptUrl: recipient.occupantId
            ? portalReceiptUrl(panelBaseUrl, condominiumId, receipt.unitId, receipt.id)
            : undefined,
        }),
        attachments: [
          { filename: pdfFilename, content: pdfBytes, contentType: "application/pdf" },
        ],
      });
      sent++;
      newRecords.push({ email: recipient.email, sentAt: new Date().toISOString(), status: "sent" });
    } catch (e) {
      failed++;
      newRecords.push({
        email: recipient.email,
        sentAt: new Date().toISOString(),
        status: "failed",
        error: (e as Error).message,
      });
    }
  }

  if (newRecords.length === 0) {
    throw new AppError({
      message: "Nenhum recipient com email + receive_receipt_emails=TRUE",
      statusCode: STATUS_CODE.BadRequest,
      code: "NO_RECIPIENTS",
    });
  }

  // Append aos records existentes (preservando histórico)
  const existingRecords = (receipt.emailSentTo ?? []) as EmailSendRecord[];
  await postgres.query((db) =>
    db.update(schema.receipt)
      .set({
        emailSentTo: [...existingRecords, ...newRecords],
        emailLastAttemptAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.receipt.id, receipt.id))
  );

  return ctx.json({ data: { sent, failed, records: newRecords } });
};
