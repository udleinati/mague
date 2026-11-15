// GET /v1/admin/condominiums/:cid/bank-accounts/with-stats
//
// Contas bancárias com stats pré-agregados (saldo, contagem total/pendentes) via JOIN+GROUP BY,
// em vez de o panel puxar ~1000 bank_transactions e somar em JS.
// Resposta: { ...bankAccount, txCount, pendingCount, currentBalanceCents }.

import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";

export const listBankAccountsWithStats = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const result = await postgres.query((db) =>
    db.execute(sql`
      SELECT
        ba.id,
        ba.condominium_id,
        ba.bank_name,
        ba.account_name,
        ba.iban,
        ba.kind,
        ba.account_holder,
        ba.is_active,
        ba.is_quota_payment,
        ba.opening_balance,
        ba.opening_balance_ordinary_cents,
        ba.opening_balance_fcr_cents,
        ba.opening_balance_date,
        ba.created_at,
        COALESCE(t.tx_count, 0)::int        AS tx_count,
        COALESCE(t.pending_count, 0)::int   AS pending_count,
        (ba.opening_balance + COALESCE(t.tx_sum, 0))::int AS current_balance_cents
      FROM finance.bank_account ba
      LEFT JOIN (
        SELECT
          bank_account_id,
          COUNT(*)::int AS tx_count,
          SUM(amount)::int AS tx_sum,
          COUNT(*) FILTER (WHERE status = 'unreconciled')::int AS pending_count
        FROM finance.bank_transaction
        WHERE condominium_id = ${condominiumId}
        GROUP BY bank_account_id
      ) t ON t.bank_account_id = ba.id
      WHERE ba.condominium_id = ${condominiumId}
        AND ba.deleted_at IS NULL
      ORDER BY ba.bank_name ASC, ba.created_at ASC
    `)
  );

  // Postgres-js devolve snake_case; convertemos para camelCase como o resto da API.
  const data = (result as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: r.id,
    condominiumId: r.condominium_id,
    bankName: r.bank_name,
    accountName: r.account_name,
    iban: r.iban,
    kind: r.kind,
    accountHolder: r.account_holder,
    isActive: r.is_active,
    isQuotaPayment: r.is_quota_payment,
    openingBalance: Number(r.opening_balance),
    openingBalanceOrdinaryCents: Number(r.opening_balance_ordinary_cents),
    openingBalanceFcrCents: Number(r.opening_balance_fcr_cents),
    openingBalanceDate: r.opening_balance_date,
    createdAt: r.created_at,
    txCount: Number(r.tx_count),
    pendingCount: Number(r.pending_count),
    currentBalanceCents: Number(r.current_balance_cents),
  }));

  return ctx.json({ data });
};
