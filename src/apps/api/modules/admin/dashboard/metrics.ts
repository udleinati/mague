// GET /v1/admin/condominiums/:cid/dashboard/metrics?year=YYYY&month=YYYY-MM
//
// Devolve os 3 KPIs de dashboard que dependem de iterar todas as receivables:
//   - paidThisMonthCents: Σ original_amount onde competence_period começa em
//     `month` E status='paid' E nature='debit' E unit_id IS NOT NULL
//   - totalIssued: count de receivables (debit, scope!='condominium') do `year`
//   - totalPaidCount: subset com status='paid'
//
// `collectionRate` é derivado client-side: totalPaidCount / totalIssued × 100.
// 1 query agregada (em vez de trazer 1000+ rows só para 3 escalares).
//
// Defaults: year=ano corrente, month=mês corrente (YYYY-MM).

import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";

export const dashboardMetrics = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const today = new Date().toISOString().slice(0, 10);
  const yearParam = ctx.req.query("year");
  const monthParam = ctx.req.query("month");
  const year = yearParam && /^\d{4}$/.test(yearParam)
    ? Number(yearParam)
    : Number(today.slice(0, 4));
  const month = monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : today.slice(0, 7);

  const rows = await postgres.query((db) =>
    db.execute<{
      total_issued: number;
      total_paid_count: number;
      paid_this_month_cents: number;
    }>(sql`
      SELECT
        COUNT(*)::int AS total_issued,
        COUNT(*) FILTER (WHERE status = 'paid')::int AS total_paid_count,
        COALESCE(
          SUM(original_amount) FILTER (
            WHERE status = 'paid'
              AND competence_period IS NOT NULL
              AND TO_CHAR(competence_period, 'YYYY-MM') = ${month}
          ),
          0
        )::int AS paid_this_month_cents
      FROM finance.charge
      WHERE condominium_id = ${condominiumId}
        AND kind = 'receivable'
        AND nature = 'debit'
        AND scope <> 'condominium'
        AND unit_id IS NOT NULL
        AND EXTRACT(YEAR FROM issue_date)::int = ${year}
    `)
  );

  const row = rows[0];
  const totalIssued = Number(row?.total_issued ?? 0);
  const totalPaidCount = Number(row?.total_paid_count ?? 0);
  const paidThisMonthCents = Number(row?.paid_this_month_cents ?? 0);
  const collectionRate = totalIssued > 0 ? Math.round((totalPaidCount / totalIssued) * 100) : 0;

  return ctx.json({
    data: {
      year,
      month,
      totalIssued,
      totalPaidCount,
      paidThisMonthCents,
      collectionRate,
    },
  });
};
