// GET /v1/admin/condominiums/:cid/bank_transactions/activity_summary
//
// Agregados de bank_transactions sem trazer rows individuais (2 queries SQL vs ~360 rows
// no panel). Substitui o listBankTransactions() do dashboard para contar pendentes +
// gráfico de 12 meses (panel filtra 3M/6M/12M client-side).
// Resposta: { pendingCount, txTotalCents (Σ amount, dá saldo físico = opening + txTotal),
//   activityByMonth: [{ ym, label, inCents, outCents }] (12 buckets, current month last) }.
// `ignored` (duplicados/erros) sai do saldo e do gráfico - nunca entra no ledger, logo
// inflava o saldo físico e o "por conciliar". `reversed` fica: o estorno é a linha original
// + a linha de retorno importada, ambas reais no extrato (net = efeito real no banco).

import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";

export const bankActivitySummary = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  // 12 buckets mensais; LEFT JOIN com a série dos 12 meses garante 0-fill de meses sem atividade.
  const result = await postgres.query((db) =>
    db.execute(sql`
      WITH months AS (
        SELECT (date_trunc('month', CURRENT_DATE) - (i || ' months')::interval)::date AS month_start
        FROM generate_series(0, 11) AS i
      ),
      tx_by_month AS (
        SELECT
          date_trunc('month', transaction_date)::date AS month_start,
          SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)::int AS in_cents,
          SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END)::int AS out_cents
        FROM finance.bank_transaction
        WHERE condominium_id = ${condominiumId}
          AND transaction_date >= (date_trunc('month', CURRENT_DATE) - INTERVAL '11 months')::date
          AND COALESCE(status, 'unreconciled') <> 'ignored'
        GROUP BY 1
      )
      SELECT
        m.month_start,
        TO_CHAR(m.month_start, 'YYYY-MM') AS ym,
        COALESCE(t.in_cents, 0)::int AS in_cents,
        COALESCE(t.out_cents, 0)::int AS out_cents
      FROM months m
      LEFT JOIN tx_by_month t USING (month_start)
      ORDER BY m.month_start ASC
    `)
  );

  const buckets = (result as unknown as Array<{
    month_start: string;
    ym: string;
    in_cents: number;
    out_cents: number;
  }>).map((r) => ({
    ym: String(r.ym),
    label: monthLabelPt(String(r.ym)),
    inCents: Number(r.in_cents),
    outCents: Number(r.out_cents),
  }));

  // count_pendentes + soma_total numa só query.
  const aggResult = await postgres.query((db) =>
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status NOT IN ('reconciled','ignored'))::int AS pending_count,
        COALESCE(SUM(amount) FILTER (WHERE COALESCE(status, 'unreconciled') <> 'ignored'), 0)::int AS tx_total_cents
      FROM finance.bank_transaction
      WHERE condominium_id = ${condominiumId}
    `)
  );
  const aggRow = (aggResult as unknown as Array<{
    pending_count: number;
    tx_total_cents: number;
  }>)[0];
  const pendingCount = Number(aggRow?.pending_count ?? 0);
  const txTotalCents = Number(aggRow?.tx_total_cents ?? 0);

  return ctx.json({
    data: {
      pendingCount,
      txTotalCents,
      activityByMonth: buckets,
    },
  });
};

const MONTH_LABELS_PT = [
  "Jan",
  "Fev",
  "Mar",
  "Abr",
  "Mai",
  "Jun",
  "Jul",
  "Ago",
  "Set",
  "Out",
  "Nov",
  "Dez",
];
function monthLabelPt(ym: string): string {
  // ym = "2026-03" → "Mar"
  const m = parseInt(ym.slice(5, 7), 10);
  return MONTH_LABELS_PT[m - 1] ?? ym;
}
