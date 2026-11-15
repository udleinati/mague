// GET /v1/admin/condominiums/:cid/reports/cashflow?months=N
//
// Previsão de tesouraria: quando entra e quando sai, mês a mês, a partir do
// saldo bancário de hoje. Duas fontes:
//   1. charges em aberto  -> por COALESCE(due_date, competence_period).
//   2. recurring_template -> ocorrências ainda não geradas, projetadas de
//      next_run_date para a frente (o que já foi gerado é charge e já conta
//      em 1; a fronteira é exatamente next_run_date).
//
// Quotas de orçamentos aprovados mas ainda por gerar NÃO entram - a previsão
// só conta compromissos já lançados. Créditos de frações por usar saem como
// KPI à parte: não são saída de caixa, mas reduzem recebimentos futuros.
//
// Saldo projetado por bolsa (121 ordinária / 122 FCR): a parte FCR de cada
// charge vem de `fn_charge_fcr_split`, a mesma função que o trigger de
// settlement usa para dividir o lado bancário. Hoje só quotas com FCR trazem
// parte 122; payables e recorrentes saem/entram todos na ordinária.

import type { Context } from "hono";
import { sql } from "drizzle-orm";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { advanceByInterval } from "$api/modules/admin/recurring_template/date_helpers.ts";

const DEFAULT_HORIZON = 12;
const MAX_HORIZON = 36;

interface ChargeBucketRow extends Record<string, unknown> {
  bucket_key: string;
  kind: string;
  open_cents: number;
  fcr_cents: number;
  charge_count: number;
}

interface TemplateRow extends Record<string, unknown> {
  id: string;
  kind: string;
  description: string;
  amount: number;
  interval_type: string;
  next_run_date: string;
  end_date: string | null;
}

export const cashflowReport = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const monthsParam = Number(ctx.req.query("months"));
  const horizonMonths = Number.isInteger(monthsParam) && monthsParam > 0
    ? Math.min(monthsParam, MAX_HORIZON)
    : DEFAULT_HORIZON;

  const today = new Date().toISOString().slice(0, 10);
  const firstMonth = today.slice(0, 7);
  const monthKeys: string[] = [];
  {
    let [y, m] = firstMonth.split("-").map(Number);
    for (let i = 0; i < horizonMonths; i++) {
      monthKeys.push(`${y}-${String(m).padStart(2, "0")}`);
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
  }
  const horizonEnd = lastDayOfMonth(monthKeys[monthKeys.length - 1]);

  const [balanceRows, chargeRows, creditRows, templates] = await Promise.all([
    postgres.query((db) =>
      db.execute<{ ordinary_cents: number; fcr_cents: number; total_cents: number }>(sql`
        SELECT COALESCE(ordinary_cents, 0)::int AS ordinary_cents,
               COALESCE(fcr_cents, 0)::int      AS fcr_cents,
               COALESCE(total_cents, 0)::int    AS total_cents
        FROM finance.v_bank_balance
        WHERE condominium_id = ${condominiumId}
      `)
    ),
    // Agrupa em SQL: a previsão não precisa das ~250 charges linha a linha.
    postgres.query((db) =>
      db.execute<ChargeBucketRow>(sql`
        SELECT CASE
                 WHEN COALESCE(c.due_date, c.competence_period) < ${today} THEN 'overdue'
                 ELSE TO_CHAR(COALESCE(c.due_date, c.competence_period), 'YYYY-MM')
               END AS bucket_key,
               c.kind,
               SUM(c.open_amount)::int AS open_cents,
               SUM(s.fcr_part)::int    AS fcr_cents,
               COUNT(*)::int           AS charge_count
        FROM finance.charge c
        CROSS JOIN LATERAL finance.fn_charge_fcr_split(c.id, c.open_amount) s
        WHERE c.condominium_id = ${condominiumId}
          AND c.status <> 'cancelled'
          AND c.open_amount > 0
          AND ((c.kind = 'receivable' AND c.nature = 'debit') OR c.kind = 'payable')
        GROUP BY 1, 2
      `)
    ),
    postgres.query((db) =>
      db.execute<{ open_cents: number; charge_count: number }>(sql`
        SELECT COALESCE(SUM(open_amount), 0)::int AS open_cents,
               COUNT(*)::int                      AS charge_count
        FROM finance.charge
        WHERE condominium_id = ${condominiumId}
          AND status <> 'cancelled'
          AND open_amount > 0
          AND kind = 'receivable'
          AND nature = 'credit'
      `)
    ),
    postgres.query((db) =>
      db.execute<TemplateRow>(sql`
        SELECT id, kind, description, amount, interval_type,
               next_run_date::text AS next_run_date, end_date::text AS end_date
        FROM core.recurring_template
        WHERE condominium_id = ${condominiumId}
          AND deleted_at IS NULL
          AND is_active = true
        ORDER BY next_run_date, description
      `)
    ),
  ]);

  const balance = {
    ordinaryCents: Number(balanceRows[0]?.ordinary_cents ?? 0),
    fcrCents: Number(balanceRows[0]?.fcr_cents ?? 0),
    totalCents: Number(balanceRows[0]?.total_cents ?? 0),
  };

  const buckets = new Map<string, Bucket>();
  const bucketFor = (key: string) => {
    const existing = buckets.get(key);
    if (existing) return existing;
    const fresh = emptyBucket(key);
    buckets.set(key, fresh);
    return fresh;
  };

  // Vencido = data < hoje (não < mês corrente): uma quota de dia 5 já está em
  // atraso a 21. O SQL já devolve 'overdue' nesses casos.
  for (const row of chargeRows) {
    const key = bucketKey(row.bucket_key ?? "overdue", monthKeys);
    const b = bucketFor(key);
    const cents = Number(row.open_cents);
    const fcrCents = Number(row.fcr_cents);
    if (row.kind === "receivable") {
      b.chargeInCents += cents;
      b.chargeInFcrCents += fcrCents;
      b.chargeInCount += Number(row.charge_count);
    } else {
      b.chargeOutCents += cents;
      b.chargeOutFcrCents += fcrCents;
      b.chargeOutCount += Number(row.charge_count);
    }
  }

  const recurring = templates.map((t) => {
    let occurrences = 0;
    let cursor = t.next_run_date;
    while (cursor <= horizonEnd && (t.end_date === null || t.end_date >= cursor)) {
      const key = cursor < today ? "overdue" : bucketKey(cursor.slice(0, 7), monthKeys);
      const b = bucketFor(key);
      if (t.kind === "receivable") b.recurringInCents += Number(t.amount);
      else b.recurringOutCents += Number(t.amount);
      occurrences += 1;
      cursor = advanceByInterval(cursor, t.interval_type);
    }
    return {
      id: t.id,
      kind: t.kind,
      description: t.description,
      amountCents: Number(t.amount),
      intervalType: t.interval_type,
      nextRunDate: t.next_run_date,
      endDate: t.end_date,
      occurrencesInHorizon: occurrences,
    };
  });

  // Ordem de leitura: atraso -> meses do horizonte -> depois. O saldo
  // projetado acumula por esta ordem.
  const orderedKeys = ["overdue", ...monthKeys, "later"];
  let runningOrd = balance.ordinaryCents;
  let runningFcr = balance.fcrCents;
  const rows = orderedKeys.map((key) => {
    const b = buckets.get(key) ?? emptyBucket(key);
    const inCents = b.chargeInCents + b.recurringInCents;
    const outCents = b.chargeOutCents + b.recurringOutCents;
    // Recorrentes não têm parte FCR (o gerador cria supplier_service /
    // recurring_fee, nenhum com crédito em 723) - só as charges a dividem.
    const inFcrCents = b.chargeInFcrCents;
    const outFcrCents = b.chargeOutFcrCents;
    runningOrd += (inCents - inFcrCents) - (outCents - outFcrCents);
    runningFcr += inFcrCents - outFcrCents;
    return {
      ...b,
      kind: key === "overdue" ? "overdue" : key === "later" ? "later" : "month",
      month: key === "overdue" || key === "later" ? null : key,
      inCents,
      outCents,
      inFcrCents,
      outFcrCents,
      netCents: inCents - outCents,
      closingOrdinaryCents: runningOrd,
      closingFcrCents: runningFcr,
      closingCents: runningOrd + runningFcr,
    };
  }).filter((r) => r.kind !== "later" || r.inCents > 0 || r.outCents > 0);

  const totals = rows.reduce((acc, r) => {
    acc.inCents += r.inCents;
    acc.outCents += r.outCents;
    acc.inFcrCents += r.inFcrCents;
    acc.outFcrCents += r.outFcrCents;
    return acc;
  }, { inCents: 0, outCents: 0, inFcrCents: 0, outFcrCents: 0 });

  return ctx.json({
    data: {
      today,
      horizonMonths,
      horizonEnd,
      balance,
      unusedCredits: {
        openCents: Number(creditRows[0]?.open_cents ?? 0),
        count: Number(creditRows[0]?.charge_count ?? 0),
      },
      rows,
      recurring,
      totals: {
        ...totals,
        netCents: totals.inCents - totals.outCents,
        projectedClosingOrdinaryCents: runningOrd,
        projectedClosingFcrCents: runningFcr,
        projectedClosingCents: runningOrd + runningFcr,
      },
    },
  });
};

interface Bucket {
  key: string;
  chargeInCents: number;
  chargeOutCents: number;
  chargeInFcrCents: number;
  chargeOutFcrCents: number;
  chargeInCount: number;
  chargeOutCount: number;
  recurringInCents: number;
  recurringOutCents: number;
}

function emptyBucket(key: string): Bucket {
  return {
    key,
    chargeInCents: 0,
    chargeOutCents: 0,
    chargeInFcrCents: 0,
    chargeOutFcrCents: 0,
    chargeInCount: 0,
    chargeOutCount: 0,
    recurringInCents: 0,
    recurringOutCents: 0,
  };
}

/** 'overdue' passa; 'YYYY-MM' dentro do horizonte fica, fora dele vai a 'later'. */
function bucketKey(key: string, monthKeys: string[]): string {
  if (key === "overdue") return key;
  return monthKeys.includes(key) ? key : "later";
}

function lastDayOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const d = new Date(Date.UTC(nextY, nextM - 1, 1));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
