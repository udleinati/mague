// GET /v1/admin/condominiums/:cid/reports/cash-movements?year=YYYY
//
// Extrato anual das duas bolsas do ledger: ordinária (121) e FCR (122). O que
// o dashboard mostra como saldo instantâneo, aqui abre-se em saldo inicial ->
// movimentos -> saldo final, com resumo mensal e por contrapartida.
//
// Uma linha por EVENTO, não por linha de ledger: as pernas 121 e 122 do mesmo
// settlement (a quota parte-se em ordinário + FCR) colapsam numa linha com
// duas colunas. Agrupa por (ref_type, ref_id, entry_type, entry_date) - o
// entry_type separa o lançamento original da sua reversão, que partilham ref.

import type { Context } from "hono";
import { sql } from "drizzle-orm";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { loadAccountNames } from "./_accounts.ts";

const ACC_ORDINARY = "121";
const ACC_FCR = "122";

// entry_type do ledger -> PT-PT. Fonte: triggers de components/004_trg_financial.sql
// + handlers TS (openingBalance, fcrTransfer).
const ENTRY_TYPE_LABELS: Record<string, string> = {
  bank_reconciliation: "Conciliação bancária",
  bank_deposit_credit: "Depósito / crédito",
  settlement_applied: "Imputação de crédito",
  settlement_reversed: "Reversão de imputação",
  openingBalance: "Saldo de abertura",
  fcrTransfer: "Transferência entre bolsas",
};

interface EventRow extends Record<string, unknown> {
  ref_type: string | null;
  ref_id: string | null;
  entry_type: string;
  entry_date: string;
  description: string | null;
  ordinary_cents: number;
  fcr_cents: number;
  counterpart_codes: string[] | null;
}

export const cashMovementsReport = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const yearsRows = await postgres.query((db) =>
    db.execute<{ year: number }>(sql`
      SELECT DISTINCT EXTRACT(YEAR FROM entry_date)::int AS year
      FROM finance.ledger
      WHERE condominium_id = ${condominiumId}
        AND account_code IN (${ACC_ORDINARY}, ${ACC_FCR})
      ORDER BY year DESC
    `)
  );
  const availableYears = yearsRows.map((r) => Number(r.year));

  const yearParam = ctx.req.query("year");
  const year = yearParam && /^\d{4}$/.test(yearParam)
    ? Number(yearParam)
    : (availableYears[0] ?? new Date().getFullYear());

  const yearStart = `${year}-01-01`;
  const nextYearStart = `${year + 1}-01-01`;

  const [openingRows, eventRows, accountNames] = await Promise.all([
    postgres.query((db) =>
      db.execute<{ ordinary_cents: number; fcr_cents: number }>(sql`
        SELECT
          COALESCE(SUM(CASE WHEN account_code = ${ACC_ORDINARY}
                            THEN CASE WHEN direction = 'debit' THEN amount ELSE -amount END
                            ELSE 0 END), 0)::int AS ordinary_cents,
          COALESCE(SUM(CASE WHEN account_code = ${ACC_FCR}
                            THEN CASE WHEN direction = 'debit' THEN amount ELSE -amount END
                            ELSE 0 END), 0)::int AS fcr_cents
        FROM finance.ledger
        WHERE condominium_id = ${condominiumId}
          AND account_code IN (${ACC_ORDINARY}, ${ACC_FCR})
          AND entry_date < ${yearStart}
      `)
    ),
    postgres.query((db) =>
      db.execute<EventRow>(sql`
        WITH bank AS (
          SELECT
            l.ref_type,
            l.ref_id,
            l.entry_type,
            l.entry_date,
            MIN(l.description) FILTER (WHERE l.description <> '') AS description,
            SUM(CASE WHEN l.account_code = ${ACC_ORDINARY}
                     THEN CASE WHEN l.direction = 'debit' THEN l.amount ELSE -l.amount END
                     ELSE 0 END)::int AS ordinary_cents,
            SUM(CASE WHEN l.account_code = ${ACC_FCR}
                     THEN CASE WHEN l.direction = 'debit' THEN l.amount ELSE -l.amount END
                     ELSE 0 END)::int AS fcr_cents,
            MIN(l.created_at) AS created_at
          FROM finance.ledger l
          WHERE l.condominium_id = ${condominiumId}
            AND l.account_code IN (${ACC_ORDINARY}, ${ACC_FCR})
            AND l.entry_date >= ${yearStart}
            AND l.entry_date < ${nextYearStart}
          GROUP BY l.ref_type, l.ref_id, l.entry_type, l.entry_date
        )
        SELECT b.ref_type, b.ref_id, b.entry_type, b.entry_date::text AS entry_date,
               b.description, b.ordinary_cents, b.fcr_cents, cp.codes AS counterpart_codes
        FROM bank b
        LEFT JOIN LATERAL (
          SELECT array_agg(DISTINCT o.account_code) AS codes
          FROM finance.ledger o
          WHERE o.condominium_id = ${condominiumId}
            AND o.ref_type = b.ref_type
            AND o.ref_id = b.ref_id
            AND o.entry_type = b.entry_type
            AND o.account_code NOT IN (${ACC_ORDINARY}, ${ACC_FCR})
        ) cp ON b.ref_id IS NOT NULL
        ORDER BY b.entry_date, b.created_at
      `)
    ),
    loadAccountNames(postgres, condominiumId),
  ]);

  const opening = {
    ordinaryCents: Number(openingRows[0]?.ordinary_cents ?? 0),
    fcrCents: Number(openingRows[0]?.fcr_cents ?? 0),
  };

  let runningOrdinary = opening.ordinaryCents;
  let runningFcr = opening.fcrCents;

  interface MonthBucket {
    ordinaryInCents: number;
    ordinaryOutCents: number;
    fcrInCents: number;
    fcrOutCents: number;
  }
  const monthBuckets = new Map<string, MonthBucket>();
  const byAccount = new Map<string, {
    code: string;
    name: string;
    inCents: number;
    outCents: number;
    count: number;
  }>();

  const events = eventRows.map((row) => {
    const ordinaryCents = Number(row.ordinary_cents);
    const fcrCents = Number(row.fcr_cents);
    runningOrdinary += ordinaryCents;
    runningFcr += fcrCents;

    const month = row.entry_date.slice(0, 7);
    const bucket = monthBuckets.get(month) ??
      { ordinaryInCents: 0, ordinaryOutCents: 0, fcrInCents: 0, fcrOutCents: 0 };
    if (ordinaryCents >= 0) bucket.ordinaryInCents += ordinaryCents;
    else bucket.ordinaryOutCents += -ordinaryCents;
    if (fcrCents >= 0) bucket.fcrInCents += fcrCents;
    else bucket.fcrOutCents += -fcrCents;
    monthBuckets.set(month, bucket);

    const codes = row.counterpart_codes ?? [];
    const totalCents = ordinaryCents + fcrCents;
    // Contrapartida principal = 1º code. Eventos com várias (settlement que
    // salda 2 charges) contam o total na primeira - o detalhe fica na linha.
    // Sem contrapartida fora das bolsas (transferência entre elas): agrupa
    // pelo próprio tipo de lançamento em vez de cair num balde "-".
    const mainCode = codes[0] ?? `~${row.entry_type}`;
    const agg = byAccount.get(mainCode) ?? {
      code: codes[0] ?? "",
      name: accountNames.get(mainCode) ?? ENTRY_TYPE_LABELS[row.entry_type] ?? row.entry_type,
      inCents: 0,
      outCents: 0,
      count: 0,
    };
    if (totalCents >= 0) agg.inCents += totalCents;
    else agg.outCents += -totalCents;
    agg.count += 1;
    byAccount.set(mainCode, agg);

    return {
      id: `${row.entry_type}:${row.ref_type ?? ""}:${row.ref_id ?? ""}:${row.entry_date}`,
      date: row.entry_date,
      month,
      entryType: row.entry_type,
      entryTypeLabel: ENTRY_TYPE_LABELS[row.entry_type] ?? row.entry_type,
      description: row.description ?? "",
      refType: row.ref_type,
      refId: row.ref_id,
      counterpartCodes: codes,
      counterpartNames: codes.map((c) => accountNames.get(c) ?? c),
      ordinaryCents,
      fcrCents,
      totalCents,
      ordinaryBalanceCents: runningOrdinary,
      fcrBalanceCents: runningFcr,
      totalBalanceCents: runningOrdinary + runningFcr,
    };
  });

  // 12 meses sempre presentes: um mês sem movimento arrasta o saldo anterior,
  // que é o que faz o extrato ler-se como extrato.
  let carryOrdinary = opening.ordinaryCents;
  let carryFcr = opening.fcrCents;
  const months = Array.from({ length: 12 }, (_, i) => {
    const month = `${year}-${String(i + 1).padStart(2, "0")}`;
    const b = monthBuckets.get(month) ??
      { ordinaryInCents: 0, ordinaryOutCents: 0, fcrInCents: 0, fcrOutCents: 0 };
    carryOrdinary += b.ordinaryInCents - b.ordinaryOutCents;
    carryFcr += b.fcrInCents - b.fcrOutCents;
    return {
      month,
      ...b,
      ordinaryClosingCents: carryOrdinary,
      fcrClosingCents: carryFcr,
      totalClosingCents: carryOrdinary + carryFcr,
      hasMovements: monthBuckets.has(month),
    };
  });

  const totals = events.reduce((acc, e) => {
    if (e.ordinaryCents >= 0) acc.ordinaryInCents += e.ordinaryCents;
    else acc.ordinaryOutCents += -e.ordinaryCents;
    if (e.fcrCents >= 0) acc.fcrInCents += e.fcrCents;
    else acc.fcrOutCents += -e.fcrCents;
    return acc;
  }, { ordinaryInCents: 0, ordinaryOutCents: 0, fcrInCents: 0, fcrOutCents: 0 });

  return ctx.json({
    data: {
      year,
      availableYears,
      opening: {
        ordinaryCents: opening.ordinaryCents,
        fcrCents: opening.fcrCents,
        totalCents: opening.ordinaryCents + opening.fcrCents,
      },
      closing: {
        ordinaryCents: runningOrdinary,
        fcrCents: runningFcr,
        totalCents: runningOrdinary + runningFcr,
      },
      totals: {
        ...totals,
        inCents: totals.ordinaryInCents + totals.fcrInCents,
        outCents: totals.ordinaryOutCents + totals.fcrOutCents,
      },
      months,
      byAccount: [...byAccount.values()].sort((a, b) =>
        (b.inCents + b.outCents) - (a.inCents + a.outCents)
      ),
      events,
    },
  });
};
