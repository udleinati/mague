// GET /v1/admin/condominiums/:cid/receipts/skipped - tuplas (bank_tx, unit) ignoradas
// (skip ativo, deletedAt IS NULL) para a fila "Ignoradas" do panel.

import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";

interface SkippedRow {
  id: string;
  condominiumId: string;
  bankTransactionId: string;
  unitId: string;
  paymentDate: string;
  bankTxDescription: string | null;
  bankAccountId: string;
  recipientAmount: number;
  reason: string | null;
  skippedAt: string;
  skippedByName: string | null;
}

export const listSkippedReceipts = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  // receipt_skip JOIN bank_tx + settlement (recipient_amount somado por unidade), mesma
  // agregação que vw_pending_receipts mas SEM o filtro de skip (queremos as ignoradas).
  const result = await postgres.query((db) =>
    db.execute<{
      id: string;
      condominium_id: string;
      bank_transaction_id: string;
      unit_id: string;
      payment_date: string;
      bank_tx_description: string | null;
      bank_account_id: string;
      recipient_amount: number;
      reason: string | null;
      skipped_at: string;
      skipped_by_name: string | null;
    }>(sql`
      SELECT rs.id,
             rs.condominium_id,
             rs.bank_transaction_id,
             rs.unit_id,
             bt.transaction_date              AS payment_date,
             bt.description                   AS bank_tx_description,
             bt.bank_account_id,
             COALESCE(SUM(s.amount)::integer, 0) AS recipient_amount,
             rs.reason,
             rs.created_at                    AS skipped_at,
             rs.skipped_by ->> 'name'         AS skipped_by_name
        FROM finance.receipt_skip rs
        -- Cross-tenant guard: o JOIN com bank_transaction filtra também
        -- por condominium_id (defesa em profundidade - sem isto, uma row
        -- plantada em receipt_skip referenciando bt de outro condo
        -- vazaria descrição/data/valor da bt).
        JOIN finance.bank_transaction bt
          ON bt.id = rs.bank_transaction_id
         AND bt.condominium_id = rs.condominium_id
        LEFT JOIN finance.settlement s
          ON s.bank_transaction_id = rs.bank_transaction_id
         AND s.status = 'active'
         AND s.settlement_type IN ('bank_reconciliation', 'bank_deposit_credit')
         AND COALESCE(s.unit_id, (
           SELECT c.unit_id FROM finance.charge c
            WHERE c.id = COALESCE(s.debit_charge_id, s.credit_charge_id)
              AND c.condominium_id = rs.condominium_id
         )) = rs.unit_id
       WHERE rs.condominium_id = ${condominiumId}
         AND rs.deleted_at IS NULL
       GROUP BY rs.id, rs.condominium_id, rs.bank_transaction_id, rs.unit_id,
                bt.transaction_date, bt.description, bt.bank_account_id,
                rs.reason, rs.created_at, rs.skipped_by
       ORDER BY rs.created_at DESC
    `)
  );

  const rows: SkippedRow[] = result.map((r) => ({
    id: r.id,
    condominiumId: r.condominium_id,
    bankTransactionId: r.bank_transaction_id,
    unitId: r.unit_id,
    paymentDate: r.payment_date,
    bankTxDescription: r.bank_tx_description,
    bankAccountId: r.bank_account_id,
    recipientAmount: Number(r.recipient_amount),
    reason: r.reason,
    skippedAt: r.skipped_at,
    skippedByName: r.skipped_by_name,
  }));

  return ctx.json({ data: rows });
};
