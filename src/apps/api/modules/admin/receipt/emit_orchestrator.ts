// Pipeline atómico de emissão de recibos, em 3 fases que `emitReceipt` encadeia:
//   1. `buildSnapshots` - SELECT-only; congela o estado no recibo.
//   2. `runReceiptTransaction` - lock + sequence + render PDF + S3 + INSERT, numa transação
//      atómica (cria a row completa ou nada).
//   3. `notifyRecipients` (notify.ts) - após a transação; best-effort, falhas em `email_sent_to`.

import { sql } from "drizzle-orm";
import { STATUS_CODE } from "@std/http";
import { AppError } from "$api/libs/error/app_error.ts";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { schema } from "$api/libs/postgres/schemas/mod.ts";
import { byIdInCondo } from "$api/libs/shared/by_id_in_condo.ts";
import type {
  BankTxSnapshot,
  CondominiumSnapshot,
  IssuedByActor,
  LineSnapshot,
  RecipientSnapshot,
  UnitSnapshot,
} from "$api/libs/postgres/schemas/receipt.ts";
import { renderPdf } from "$api/libs/pdf/render.ts";
import { deleteObject, ensureBucket, putObject } from "$api/libs/storage/s3.ts";
import { buildEntityStorageKey } from "$api/libs/storage/storage_key.ts";
import { nanoid } from "nanoid";
import { renderReceiptHtml } from "./pdf.ts";
import { notifyRecipients } from "./notify.ts";
import { humanizeChargeLine, maskIban } from "./format.ts";
import type { RecipientLive, SnapshotsBundle } from "./_shared.ts";

export interface EmitReceiptInput {
  condominiumId: string;
  bankTransactionId: string;
  unitId: string;
  /** Actor que está a emitir - gravado em `issued_by`. */
  actor: IssuedByActor;
  /** Origin público para construir links nos emails. Vem do header X-Panel-Base-URL. */
  panelBaseUrl: string;
}

export interface EmitReceiptResult {
  receiptId: string;
  number: string;
  amountCents: number;
  emailsSent: number;
  emailsFailed: number;
}

// Orquestra as 3 fases. Lança AppError se a tupla não é elegível ou a fase 2 falhar.
// Falhas de envio (fase 3) são apanhadas por recipient; o caller vê `emailsFailed > 0`.
export async function emitReceipt(
  postgres: Postgres,
  input: EmitReceiptInput,
): Promise<EmitReceiptResult> {
  const { condominiumId, bankTransactionId, unitId, actor, panelBaseUrl } = input;

  // 1. Verificar elegibilidade via vw_pending_receipts (idempotência)
  const eligibilityRows = await postgres.query((db) =>
    db.execute<{
      recipient_amount: number;
      payment_date: string;
      bank_tx_amount: number;
      bank_account_id: string;
    }>(
      sql`
        SELECT recipient_amount, payment_date, bank_tx_amount, bank_account_id
          FROM finance.vw_pending_receipts
         WHERE condominium_id = ${condominiumId}
           AND bank_transaction_id = ${bankTransactionId}
           AND unit_id = ${unitId}
         LIMIT 1
      `,
    )
  );
  const eligibility = eligibilityRows[0];
  if (!eligibility) {
    throw new AppError({
      message:
        `Tupla (bank_tx=${bankTransactionId}, unit=${unitId}) não elegível para emissão (não está em vw_pending_receipts)`,
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "INVALID_STATE",
    });
  }

  // 2. Snapshots do estado atual.
  const snapshots = await buildSnapshots(postgres, {
    condominiumId,
    bankTransactionId,
    unitId,
    paymentDate: String(eligibility.payment_date),
  });

  const amountCents = Number(eligibility.recipient_amount);
  const year = new Date(String(eligibility.payment_date)).getUTCFullYear();

  // 3. Transação: lock + sequence + render PDF + S3 + INSERT.
  const receipt = await runReceiptTransaction(postgres, {
    condominiumId,
    bankTransactionId,
    unitId,
    amountCents,
    year,
    actor,
    snapshots,
    panelBaseUrl,
  });

  // 4. Notificação aos recipients (best-effort).
  const { emailsSent, emailsFailed } = await notifyRecipients(postgres, {
    receipt,
    snapshots,
    panelBaseUrl,
    actor,
  });

  return {
    receiptId: receipt.id,
    number: receipt.number ?? "",
    amountCents,
    emailsSent,
    emailsFailed,
  };
}

// ─── Fase 2: transação atómica ──────────────────────────────────────────────

interface RunReceiptTransactionInput {
  condominiumId: string;
  bankTransactionId: string;
  unitId: string;
  amountCents: number;
  year: number;
  actor: IssuedByActor;
  snapshots: SnapshotsBundle;
  panelBaseUrl: string;
}

// Lock por (condo, year) -> sequence -> render HTML+PDF -> upload S3 -> INSERT, atómico
// (rollback impede gaps no sequence). O lock fica detido durante render+upload (~5s), só
// bloqueando emissões concorrentes do mesmo (condo, ano). INSERT falhado após upload apaga o PDF.
export async function runReceiptTransaction(
  postgres: Postgres,
  input: RunReceiptTransactionInput,
): Promise<typeof schema.receipt.$inferSelect> {
  const {
    condominiumId,
    bankTransactionId,
    unitId,
    amountCents,
    year,
    actor,
    snapshots,
    panelBaseUrl,
  } = input;
  await ensureBucket();

  return await postgres.query((db) =>
    db.transaction(async (tx) => {
      // Lock por (condo, year). pg_advisory_xact_lock(int4, int4); hashtext já devolve int4.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext(${condominiumId}),
          ${year}::int
        )
      `);

      const seqRes = await tx.execute<{ next_seq: number }>(sql`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next_seq
          FROM finance.receipt
         WHERE condominium_id = ${condominiumId}
           AND year = ${year}
      `);
      const sequence = Number(seqRes[0]?.next_seq ?? 1);
      // Storage key canónico condo-first sharded (backup/restore por `s3 cp s3://bucket/<cid>/`).
      // Ver `libs/storage/storage_key.ts` + `scripts/migrate_s3_layout.ts`.
      const id = nanoid(10);
      const filename = `${year}-${String(sequence).padStart(5, "0")}.pdf`;
      const storageKey = buildEntityStorageKey({
        entity: "receipts",
        condominiumId,
        entityId: id,
        filename,
      });
      const number = `${year}/${String(sequence).padStart(5, "0")}`;
      const issuedAt = new Date();

      // Pré-construir um row "shape" para o template usar antes do INSERT.
      const partialReceipt = {
        id,
        condominiumId,
        unitId,
        bankTransactionId,
        year,
        sequence,
        number,
        amountCents,
        issuedAt,
        issuedBy: actor,
        voidedAt: null,
        voidedBy: null,
        voidedReason: null,
        condominiumSnapshot: snapshots.condominium,
        unitSnapshot: snapshots.unit,
        recipientsSnapshot: snapshots.recipients,
        linesSnapshot: snapshots.lines,
        bankTxSnapshot: snapshots.bankTx,
        storageKey,
        storageEtag: null,
        fileSize: null,
        fileSha256: null,
        emailSentTo: [],
        emailLastAttemptAt: null,
        recipientsAccess: [],
        createdAt: issuedAt,
        updatedAt: issuedAt,
        deletedAt: null,
        createdBy: {},
        updatedBy: {},
        deletedBy: null,
      } as typeof schema.receipt.$inferSelect;

      const html = await renderReceiptHtml(partialReceipt, snapshots, panelBaseUrl);
      const pdfBytes = await renderPdf({ html });
      const put = await putObject(storageKey, pdfBytes, "application/pdf");

      try {
        const inserted = await tx.insert(schema.receipt).values({
          id,
          condominiumId,
          unitId,
          bankTransactionId,
          year,
          sequence,
          amountCents,
          issuedAt,
          issuedBy: actor,
          condominiumSnapshot: snapshots.condominium,
          unitSnapshot: snapshots.unit,
          recipientsSnapshot: snapshots.recipients,
          linesSnapshot: snapshots.lines,
          bankTxSnapshot: snapshots.bankTx,
          storageKey,
          storageEtag: put.etag,
          fileSize: put.size,
          fileSha256: put.sha256,
        }).returning();
        return inserted[0];
      } catch (e) {
        await deleteObject(storageKey).catch((cleanupErr) => {
          console.error(
            `[receipt:${id}] cleanup S3 falhou após INSERT erro:`,
            cleanupErr,
          );
        });
        throw e;
      }
    })
  );
}

// ─── Snapshots ───────────────────────────────────────────────────────────────

// Constrói todos os snapshots, SELECT-only. Queries deliberadamente independentes (custo
// trivial face ao render PDF).
export async function buildSnapshots(
  postgres: Postgres,
  args: { condominiumId: string; bankTransactionId: string; unitId: string; paymentDate: string },
): Promise<SnapshotsBundle> {
  // Condominium
  const c = await postgres.query((db) =>
    db.query.condominium.findFirst({
      where: (c, ops) => ops.eq(c.id, args.condominiumId),
    })
  );
  if (!c) {
    throw new AppError({
      message: `Condomínio ${args.condominiumId} não encontrado`,
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  const condominium: CondominiumSnapshot = {
    name: c.name,
    designationType: c.designationType,
    fiscalNumber: c.fiscalNumber ?? null,
    address: c.address ?? null,
    postalCode: c.postalCode ?? null,
    city: c.city ?? null,
  };

  // Unit
  const u = await postgres.query((db) =>
    db.query.unit.findFirst({
      where: byIdInCondo(schema.unit, args.unitId, args.condominiumId),
    })
  );
  if (!u) {
    throw new AppError({
      message: `Fração ${args.unitId} não encontrada`,
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  const unit: UnitSnapshot = {
    designation: u.designation,
    identifier: u.identifier ?? null,
    permillage: Number(u.permillage ?? 0),
    unitType: u.unitType ?? null,
  };

  // Recipients - owners + residents ativos à data do pagamento; tenants de fora (ADR 0028,
  // Art. 1424 CC). `userId`/`phone` vêm em paralelo (não no JSONB) para o auto-invite do
  // email loop criar/recuperar o user e gerar accept-token sem 2.ª query.
  const recipientRows = await postgres.query((db) =>
    db.execute<{
      occupant_id: string;
      user_id: string | null;
      name: string;
      nif: string | null;
      email: string | null;
      phone: string | null;
      receive_receipt_emails: boolean;
    }>(
      sql`
        SELECT o.id AS occupant_id, o.user_id, o.name, o.nif, o.email, o.phone,
               o.receive_receipt_emails
          FROM core.unit_occupant uo
          JOIN core.occupant o ON o.id = uo.occupant_id
         WHERE uo.unit_id = ${args.unitId}
           AND uo.relationship_type IN ('owner', 'resident')
           AND uo.deleted_at IS NULL
           AND uo.start_date <= ${args.paymentDate}::date
           AND (uo.end_date IS NULL OR uo.end_date >= ${args.paymentDate}::date)
           AND o.deleted_at IS NULL
           AND o.condominium_id = ${args.condominiumId}
         ORDER BY o.name
      `,
    )
  );
  if (recipientRows.length === 0) {
    throw new AppError({
      message:
        `Sem destinatário (owner/resident) registado em ${args.paymentDate} - corrige unit_occupant primeiro`,
      statusCode: STATUS_CODE.UnprocessableEntity,
      code: "INVALID_STATE",
    });
  }
  const recipients: RecipientSnapshot[] = recipientRows.map((r: typeof recipientRows[0]) => ({
    occupantId: String(r.occupant_id),
    name: String(r.name),
    nif: r.nif ?? null,
    email: r.email ?? null,
    receiveEmails: Boolean(r.receive_receipt_emails),
  }));
  const recipientsLive: RecipientLive[] = recipientRows.map((r: typeof recipientRows[0]) => ({
    occupantId: String(r.occupant_id),
    userId: r.user_id ?? null,
    name: String(r.name),
    nif: r.nif ?? null,
    email: r.email ?? null,
    phone: r.phone ?? null,
    receiveEmails: Boolean(r.receive_receipt_emails),
  }));

  // Bank tx + bank account (snapshot)
  const btRows = await postgres.query((db) =>
    db.execute<{
      transaction_date: string;
      description: string | null;
      bank_name: string;
      account_name: string | null;
      iban: string | null;
      kind: string;
    }>(
      sql`
        SELECT bt.transaction_date, bt.description,
               ba.bank_name, ba.account_name, ba.iban, ba.kind
          FROM finance.bank_transaction bt
          JOIN finance.bank_account ba ON ba.id = bt.bank_account_id
         WHERE bt.id = ${args.bankTransactionId}
           AND bt.condominium_id = ${args.condominiumId}
         LIMIT 1
      `,
    )
  );
  const btRow = btRows[0];
  if (!btRow) {
    throw new AppError({
      message: `Bank tx ${args.bankTransactionId} não encontrada`,
      statusCode: STATUS_CODE.NotFound,
      code: "NOT_FOUND",
    });
  }
  const bankTx: BankTxSnapshot = {
    transactionDate: String(btRow.transaction_date),
    description: btRow.description ?? null,
    accountKind: btRow.kind,
    accountName: btRow.account_name ?? btRow.bank_name,
    ibanMasked: maskIban(btRow.iban),
  };

  // Lines - settlements desta unit nesta bank_tx, com a charge associada
  const lineRows = await postgres.query((db) =>
    db.execute<{
      amount: number;
      charge_type: string;
      charge_description: string;
      competence_period: string | null;
      fcr_amount: number | null;
    }>(
      sql`
        SELECT s.amount,
               c.charge_type,
               c.description AS charge_description,
               c.competence_period,
               NULL::int AS fcr_amount
          FROM finance.settlement s
          LEFT JOIN finance.charge c ON c.id = COALESCE(s.debit_charge_id, s.credit_charge_id)
         WHERE s.bank_transaction_id = ${args.bankTransactionId}
           AND COALESCE(s.unit_id, c.unit_id) = ${args.unitId}
           AND s.status = 'active'
           AND s.settlement_type IN ('bank_reconciliation', 'bank_deposit_credit')
         ORDER BY c.competence_period NULLS LAST, c.created_at
      `,
    )
  );
  const lines: LineSnapshot[] = lineRows.map((r: typeof lineRows[0]) => ({
    description: humanizeChargeLine(
      String(r.charge_description),
      String(r.charge_type),
      r.competence_period,
    ),
    amount: Number(r.amount),
    chargeType: String(r.charge_type),
    competencePeriod: r.competence_period ? String(r.competence_period) : null,
    fcrAmount: r.fcr_amount ?? null,
  }));

  return { condominium, unit, recipients, recipientsLive, lines, bankTx };
}
