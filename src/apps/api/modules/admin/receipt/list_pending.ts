// GET /v1/admin/condominiums/:cid/receipts/pending - lê `finance.vw_pending_receipts`
// (tuplas (bank_tx, unit) elegíveis sem recibo ativo). Fila de /admin/c/:cid/recibos/pendentes.

import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import type { PendingReceiptRow } from "./_projection.ts";

export const listPendingReceipts = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const result = await postgres.query((db) =>
    db.execute<{
      condominium_id: string;
      bank_transaction_id: string;
      unit_id: string;
      payment_date: string;
      bank_tx_description: string | null;
      bank_tx_amount: number;
      bank_account_id: string;
      recipient_amount: number;
      settlements_count: number;
    }>(sql`
      SELECT condominium_id, bank_transaction_id, unit_id,
             payment_date, bank_tx_description, bank_tx_amount,
             bank_account_id, recipient_amount, settlements_count
        FROM finance.vw_pending_receipts
       WHERE condominium_id = ${condominiumId}
       ORDER BY payment_date, bank_transaction_id, unit_id
    `)
  );

  const rows: PendingReceiptRow[] = result.map((r) => ({
    condominiumId: r.condominium_id,
    bankTransactionId: r.bank_transaction_id,
    unitId: r.unit_id,
    paymentDate: r.payment_date,
    bankTxDescription: r.bank_tx_description,
    bankTxAmount: Number(r.bank_tx_amount),
    bankAccountId: r.bank_account_id,
    recipientAmount: Number(r.recipient_amount),
    settlementsCount: Number(r.settlements_count),
  }));

  return ctx.json({ data: rows });
};
