// GET /v1/admin/condominiums/:cid/charges/top_open_by_group?topPerGroup=N (def 6, max 20)
// Top-N charges em aberto (open|partial|overdue) num único request:
//   - byUnit:     receivable debit por unit_id, ORDER competence_period ASC
//   - bySupplier: payable debit por supplier_id, ORDER due_date ASC
// CTE com ROW_NUMBER() em vez de trazer 5000+ charges e fatiar em JS.
// Uso: modal de reconciliação (hint de match por fração/fornecedor).

import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";

const DEFAULT_TOP = 6;
const MAX_TOP = 20;

type Row = {
  id: string;
  unit_id: string | null;
  supplier_id: string | null;
  competence_period: string | null;
  issue_date: string | null;
  due_date: string | null;
  description: string | null;
  open_amount: number;
  original_amount: number;
  status: string;
  charge_type: string | null;
  partition: "unit" | "supplier";
};

type ChargeForUnit = {
  id: string;
  competencePeriod: string | null;
  description: string | null;
  openAmount: number;
  originalAmount: number;
  status: string;
  chargeType: string | null;
};

type ChargeForSupplier = {
  id: string;
  issueDate: string | null;
  dueDate: string | null;
  description: string | null;
  openAmount: number;
  originalAmount: number;
  status: string;
  chargeType: string | null;
};

export const topOpenChargesByGroup = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);

  const topRaw = ctx.req.query("topPerGroup");
  const topParsed = topRaw ? Number.parseInt(topRaw, 10) : NaN;
  const top = Number.isFinite(topParsed) && topParsed > 0
    ? Math.min(topParsed, MAX_TOP)
    : DEFAULT_TOP;

  // ROW_NUMBER por partição + `WHERE rn <= $top`; duas CTEs (receivable +
  // payable) com UNION ALL numa só ida ao DB.
  const rows = await postgres.query((db) =>
    db.execute<Row>(sql`
      WITH open_receivable AS (
        SELECT
          id, unit_id, supplier_id, competence_period, issue_date, due_date,
          description, open_amount, original_amount, status, charge_type,
          ROW_NUMBER() OVER (
            PARTITION BY unit_id
            ORDER BY competence_period ASC NULLS LAST, id ASC
          ) AS rn
        FROM finance.charge
        WHERE condominium_id = ${condominiumId}
          AND kind = 'receivable'
          AND nature = 'debit'
          AND status = ANY(ARRAY['open','partial','overdue']::varchar[])
          AND unit_id IS NOT NULL
      ),
      open_payable AS (
        SELECT
          id, unit_id, supplier_id, competence_period, issue_date, due_date,
          description, open_amount, original_amount, status, charge_type,
          ROW_NUMBER() OVER (
            PARTITION BY supplier_id
            ORDER BY COALESCE(due_date, issue_date) ASC NULLS LAST, id ASC
          ) AS rn
        FROM finance.charge
        WHERE condominium_id = ${condominiumId}
          AND kind = 'payable'
          AND nature = 'debit'
          AND status = ANY(ARRAY['open','partial','overdue']::varchar[])
          AND supplier_id IS NOT NULL
      )
      SELECT
        id, unit_id, supplier_id, competence_period::text AS competence_period,
        issue_date::text AS issue_date, due_date::text AS due_date,
        description, open_amount, original_amount, status, charge_type,
        'unit' AS partition
      FROM open_receivable
      WHERE rn <= ${top}
      UNION ALL
      SELECT
        id, unit_id, supplier_id, competence_period::text AS competence_period,
        issue_date::text AS issue_date, due_date::text AS due_date,
        description, open_amount, original_amount, status, charge_type,
        'supplier' AS partition
      FROM open_payable
      WHERE rn <= ${top}
    `)
  );

  const byUnit: Record<string, ChargeForUnit[]> = {};
  const bySupplier: Record<string, ChargeForSupplier[]> = {};

  for (const r of rows) {
    if (r.partition === "unit" && r.unit_id) {
      const arr = byUnit[r.unit_id] ?? (byUnit[r.unit_id] = []);
      arr.push({
        id: r.id,
        competencePeriod: r.competence_period,
        description: r.description,
        openAmount: Number(r.open_amount),
        originalAmount: Number(r.original_amount),
        status: r.status,
        chargeType: r.charge_type,
      });
    } else if (r.partition === "supplier" && r.supplier_id) {
      const arr = bySupplier[r.supplier_id] ?? (bySupplier[r.supplier_id] = []);
      arr.push({
        id: r.id,
        issueDate: r.issue_date,
        dueDate: r.due_date,
        description: r.description,
        openAmount: Number(r.open_amount),
        originalAmount: Number(r.original_amount),
        status: r.status,
        chargeType: r.charge_type,
      });
    }
  }

  return ctx.json({ data: { byUnit, bySupplier } });
};
