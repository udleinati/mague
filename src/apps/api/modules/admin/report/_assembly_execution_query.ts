// Motor partilhado do relatório por Ata (lista + detalhe).
//
// A Ata liga-se ao dinheiro por um único ponto: `assembly_agenda_item` com
// `ref_type='budget'` (o ponto "aprovação do orçamento"). A partir do
// orçamento, os dois lados:
//
//   RECEITA - quotas geradas por esse orçamento. Ligação exata:
//             charge.source_type='budget' AND source_id=budget.id.
//   DESPESA - não tem ligação nativa. Imputa-se por:
//             1. charge.budget_id = budget.id       (etiqueta manual)
//             2. rubrica do orçamento + ano         (inferência, quando budget_id é NULL)
//             A inferência é AMBÍGUA se a mesma rubrica pertence a dois
//             orçamentos do mesmo ano ligados a Atas - nesse caso a despesa
//             fica marcada e a etiqueta manual é a saída.

import { sql } from "drizzle-orm";
import type { Postgres } from "$api/libs/postgres/postgres.ts";

/** Lista de valores para `IN (...)` em SQL cru - um placeholder por item. */
const inList = (values: string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

export interface AgendaRefRow extends Record<string, unknown> {
  assembly_id: string;
  assembly_type: string;
  minutes_number: string | null;
  scheduled_at: string;
  held_at: string | null;
  assembly_status: string;
  agenda_item_id: string;
  sequence: number;
  subject: string;
  approved: boolean | null;
  budget_id: string;
  budget_year: string;
  budget_type: string;
  budget_status: string;
  installments: number | null;
  approved_at: string | null;
}

export interface BudgetLineRow extends Record<string, unknown> {
  budget_id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  annual_amount: number;
}

export interface PayableRow extends Record<string, unknown> {
  id: string;
  code: string | null;
  description: string;
  invoice_number: string | null;
  account_id: string | null;
  account_code: string | null;
  account_name: string | null;
  budget_id: string | null;
  competence_period: string;
  due_date: string | null;
  status: string;
  original_amount: number;
  settled_amount: number;
  open_amount: number;
  supplier_name: string | null;
}

export interface QuotaUnitRow extends Record<string, unknown> {
  budget_id: string;
  unit_id: string;
  designation: string;
  charge_count: number;
  issued_cents: number;
  settled_cents: number;
  open_cents: number;
}

/** Pontos da ordem do dia que apontam a um orçamento, com a Ata e o orçamento. */
export function loadAgendaRefs(postgres: Postgres, condominiumId: string) {
  return postgres.query((db) =>
    db.execute<AgendaRefRow>(sql`
      SELECT a.id                    AS assembly_id,
             a.type                  AS assembly_type,
             a.minutes_number,
             a.scheduled_at::text    AS scheduled_at,
             a.held_at::text         AS held_at,
             a.status                AS assembly_status,
             ai.id                   AS agenda_item_id,
             ai.sequence,
             ai.subject,
             ai.approved,
             b.id                    AS budget_id,
             b.year                  AS budget_year,
             b.type                  AS budget_type,
             b.status                AS budget_status,
             b.installments,
             b.approved_at::text     AS approved_at
      FROM core.assembly_agenda_item ai
      JOIN core.assembly a ON a.id = ai.assembly_id
      JOIN core.budget b   ON b.id = ai.ref_id AND b.condominium_id = a.condominium_id
      WHERE a.condominium_id = ${condominiumId}
        AND a.deleted_at IS NULL
        AND ai.deleted_at IS NULL
        AND b.deleted_at IS NULL
        AND ai.ref_type = 'budget'
      ORDER BY a.scheduled_at, ai.sequence
    `)
  );
}

export function loadBudgetLines(postgres: Postgres, budgetIds: string[]) {
  if (budgetIds.length === 0) return Promise.resolve([] as BudgetLineRow[]);
  return postgres.query((db) =>
    db.execute<BudgetLineRow>(sql`
      SELECT bl.budget_id, bl.account_id, coa.code AS account_code,
             coa.name AS account_name, bl.annual_amount
      FROM core.budget_line bl
      JOIN finance.chart_of_account coa ON coa.id = bl.account_id
      WHERE bl.deleted_at IS NULL
        AND bl.budget_id IN (${inList(budgetIds)})
      ORDER BY coa.code
    `)
  );
}

/** Despesas candidatas: etiquetadas OU na rubrica+ano de algum orçamento. */
export function loadPayables(
  postgres: Postgres,
  condominiumId: string,
  budgetIds: string[],
  accountIds: string[],
  years: string[],
) {
  if (budgetIds.length === 0) return Promise.resolve([] as PayableRow[]);
  const accountFilter = accountIds.length > 0 && years.length > 0
    ? sql`OR (c.budget_id IS NULL AND c.account_id IN (${inList(accountIds)})
              AND TO_CHAR(c.competence_period, 'YYYY') IN (${inList(years)}))`
    : sql``;
  return postgres.query((db) =>
    db.execute<PayableRow>(sql`
      SELECT c.id, c.code, c.description, c.invoice_number,
             c.account_id, coa.code AS account_code, coa.name AS account_name,
             c.budget_id,
             c.competence_period::text AS competence_period,
             c.due_date::text          AS due_date,
             c.status, c.original_amount, c.settled_amount, c.open_amount,
             s.name AS supplier_name
      FROM finance.charge c
      LEFT JOIN finance.chart_of_account coa ON coa.id = c.account_id
      LEFT JOIN core.supplier s ON s.id = c.supplier_id
      WHERE c.condominium_id = ${condominiumId}
        AND c.kind = 'payable'
        AND c.status <> 'cancelled'
        AND (c.budget_id IN (${inList(budgetIds)}) ${accountFilter})
      ORDER BY c.competence_period, c.code
    `)
  );
}

/** Quotas por fração, por orçamento de origem. */
export function loadQuotaUnits(
  postgres: Postgres,
  condominiumId: string,
  budgetIds: string[],
) {
  if (budgetIds.length === 0) return Promise.resolve([] as QuotaUnitRow[]);
  return postgres.query((db) =>
    db.execute<QuotaUnitRow>(sql`
      SELECT c.source_id            AS budget_id,
             c.unit_id,
             u.designation,
             COUNT(*)::int          AS charge_count,
             SUM(c.original_amount)::int AS issued_cents,
             SUM(c.settled_amount)::int  AS settled_cents,
             SUM(c.open_amount)::int     AS open_cents
      FROM finance.charge c
      JOIN core.unit u ON u.id = c.unit_id
      WHERE c.condominium_id = ${condominiumId}
        AND c.kind = 'receivable'
        AND c.nature = 'debit'
        AND c.status <> 'cancelled'
        AND c.source_type = 'budget'
        AND c.source_id IN (${inList(budgetIds)})
      GROUP BY c.source_id, c.unit_id, u.designation
      ORDER BY LENGTH(u.designation), u.designation
    `)
  );
}
