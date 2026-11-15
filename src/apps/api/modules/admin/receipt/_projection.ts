// Projection partilhada por todos os handlers que devolvem receipts. Padrão de
// charge/_projection.ts: PROJECTION = whitelist de columns (omite `deletedAt`); format()
// = whitelist final + derivado `isVoided`. `pdfUrl` opcional: URL pré-assinada do S3, ou
// null e o frontend usa `/receipts/:id/pdf` (proxy ao S3).

import type { ReceiptSelect } from "$api/libs/postgres/schemas/receipt.ts";

const RECEIPT_TOP_LEVEL_COLUMNS = {
  id: true,
  condominiumId: true,
  unitId: true,
  bankTransactionId: true,
  year: true,
  sequence: true,
  number: true,
  amountCents: true,
  issuedAt: true,
  issuedBy: true,
  voidedAt: true,
  voidedBy: true,
  voidedReason: true,
  condominiumSnapshot: true,
  unitSnapshot: true,
  recipientsSnapshot: true,
  linesSnapshot: true,
  bankTxSnapshot: true,
  storageKey: true,
  // Não exposto na response; retrieve.ts precisa dele para decidir se gera URL pré-assinada.
  storageEtag: true,
  fileSize: true,
  emailSentTo: true,
  emailLastAttemptAt: true,
  recipientsAccess: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const RECEIPT_PROJECTION = {
  columns: RECEIPT_TOP_LEVEL_COLUMNS,
} as const;

type ReceiptRowLike = Partial<ReceiptSelect>;

export function formatReceiptForResponse(
  row: ReceiptRowLike,
  opts: { pdfUrl?: string | null } = {},
) {
  const isVoided = row.voidedAt !== null && row.voidedAt !== undefined;
  return {
    id: row.id,
    condominiumId: row.condominiumId,
    unitId: row.unitId,
    bankTransactionId: row.bankTransactionId,

    year: row.year,
    sequence: row.sequence,
    number: row.number,

    amountCents: row.amountCents,

    issuedAt: row.issuedAt,
    issuedBy: row.issuedBy ?? null,
    voidedAt: row.voidedAt ?? null,
    voidedBy: row.voidedBy ?? null,
    voidedReason: row.voidedReason ?? null,
    isVoided,

    condominiumSnapshot: row.condominiumSnapshot ?? null,
    unitSnapshot: row.unitSnapshot ?? null,
    recipientsSnapshot: row.recipientsSnapshot ?? null,
    linesSnapshot: row.linesSnapshot ?? null,
    bankTxSnapshot: row.bankTxSnapshot ?? null,

    storageKey: row.storageKey,
    fileSize: row.fileSize ?? null,
    pdfUrl: opts.pdfUrl ?? null,

    emailSentTo: row.emailSentTo ?? [],
    emailLastAttemptAt: row.emailLastAttemptAt ?? null,
    recipientsAccess: row.recipientsAccess ?? [],

    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Linha de `vw_pending_receipts` - candidato a recibo, não uma `Receipt`.
// Usado por `GET /receipts/pending` e pela fila de emissão do frontend.
export interface PendingReceiptRow {
  condominiumId: string;
  bankTransactionId: string;
  unitId: string;
  paymentDate: string; // YYYY-MM-DD
  bankTxDescription: string | null;
  bankTxAmount: number; // cêntimos
  bankAccountId: string;
  recipientAmount: number; // cêntimos - soma das settlements desta unit
  settlementsCount: number;
}
