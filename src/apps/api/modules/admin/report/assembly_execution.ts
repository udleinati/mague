// GET /v1/admin/condominiums/:cid/reports/assembly-execution
// GET /v1/admin/condominiums/:cid/reports/assembly-execution/:assemblyId
//
// "A Ata 11 previu quanto? Já se gastou quanto? As quotas dessa Ata já
// entraram?" - lista com os agregados por Ata, detalhe com as despesas linha
// a linha e a cobrança fração a fração. Regras de imputação em
// `_assembly_execution_query.ts`.

import type { Context } from "hono";
import { STATUS_CODE } from "@std/http";
import type { Postgres } from "$api/libs/postgres/postgres.ts";
import { requireCondominiumId } from "$api/libs/shared/require_condominium.ts";
import { AppError } from "$api/libs/error/app_error.ts";
import {
  type AgendaRefRow,
  loadAgendaRefs,
  loadBudgetLines,
  loadPayables,
  loadQuotaUnits,
  type PayableRow,
} from "./_assembly_execution_query.ts";
import {
  buildAccountClaims,
  type ExpenseSource,
  imputePayable,
  isAmbiguousAccount,
} from "./_impute.ts";

export const assemblyExecutionReport = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const assemblies = await buildAssemblies(postgres, condominiumId);
  return ctx.json({ data: { assemblies: assemblies.map(stripDetail) } });
};

export const assemblyExecutionDetail = async (ctx: Context, postgres: Postgres) => {
  const condominiumId = requireCondominiumId(ctx);
  const assemblyId = ctx.req.param("assemblyId");
  const assemblies = await buildAssemblies(postgres, condominiumId);
  const found = assemblies.find((a) => a.id === assemblyId);
  if (!found) {
    throw new AppError({
      message: "Assembleia sem orçamento aprovado (nada a executar).",
      statusCode: STATUS_CODE.NotFound,
      code: "ASSEMBLY_EXECUTION_NOT_FOUND",
    });
  }
  return ctx.json({ data: found });
};

async function buildAssemblies(postgres: Postgres, condominiumId: string) {
  const refs = await loadAgendaRefs(postgres, condominiumId);
  const budgetIds = [...new Set(refs.map((r) => r.budget_id))];
  if (budgetIds.length === 0) return [];

  const lines = await loadBudgetLines(postgres, budgetIds);

  const budgetYear = new Map(refs.map((r) => [r.budget_id, r.budget_year]));
  const accountIds = [...new Set(lines.map((l) => l.account_id))];
  const years = [...new Set(refs.map((r) => r.budget_year))];

  const [payables, quotaUnits] = await Promise.all([
    loadPayables(postgres, condominiumId, budgetIds, accountIds, years),
    loadQuotaUnits(postgres, condominiumId, budgetIds),
  ]);

  const claims = buildAccountClaims(lines, budgetYear);
  const reportedBudgetIds = new Set(budgetIds);

  const expensesByBudget = new Map<string, Array<PayableRow & { source: ExpenseSource }>>();
  for (const p of payables) {
    for (const hit of imputePayable(p, claims, reportedBudgetIds)) {
      const list = expensesByBudget.get(hit.budgetId) ?? [];
      list.push({ ...p, source: hit.source });
      expensesByBudget.set(hit.budgetId, list);
    }
  }

  const quotasByBudget = new Map<string, typeof quotaUnits>();
  for (const q of quotaUnits) {
    const list = quotasByBudget.get(q.budget_id) ?? [];
    list.push(q);
    quotasByBudget.set(q.budget_id, list);
  }

  const byAssembly = new Map<string, AgendaRefRow[]>();
  for (const r of refs) {
    const list = byAssembly.get(r.assembly_id) ?? [];
    list.push(r);
    byAssembly.set(r.assembly_id, list);
  }

  return [...byAssembly.values()].map((group) => {
    const head = group[0];
    const budgets = group.map((ref) => {
      const budgetLines = lines.filter((l) => l.budget_id === ref.budget_id);
      const expenses = expensesByBudget.get(ref.budget_id) ?? [];
      const units = quotasByBudget.get(ref.budget_id) ?? [];

      const counted = expenses.filter((e) => e.source !== "ambiguous");
      const actualCents = sum(counted, (e) => e.original_amount);
      const budgetedCents = sum(budgetLines, (l) => l.annual_amount);

      const lineRows = budgetLines.map((l) => {
        const mine = counted.filter((e) => e.account_id === l.account_id);
        const lineActual = sum(mine, (e) => e.original_amount);
        return {
          accountId: l.account_id,
          accountCode: l.account_code,
          accountName: l.account_name,
          budgetedCents: Number(l.annual_amount),
          actualCents: lineActual,
          varianceCents: Number(l.annual_amount) - lineActual,
          chargeCount: mine.length,
          ambiguous: isAmbiguousAccount(claims, l.account_id, ref.budget_year),
        };
      });

      const issuedCents = sum(units, (u) => u.issued_cents);
      const settledCents = sum(units, (u) => u.settled_cents);
      const openCents = sum(units, (u) => u.open_cents);

      return {
        id: ref.budget_id,
        year: ref.budget_year,
        type: ref.budget_type,
        status: ref.budget_status,
        installments: ref.installments,
        approvedAt: ref.approved_at,
        agendaItem: {
          id: ref.agenda_item_id,
          sequence: Number(ref.sequence),
          subject: ref.subject,
          approved: ref.approved,
        },
        budgetedCents,
        actualCents,
        varianceCents: budgetedCents - actualCents,
        executionPct: budgetedCents > 0 ? Math.round((actualCents / budgetedCents) * 100) : 0,
        taggedCents: sum(expenses.filter((e) => e.source === "tagged"), (e) => e.original_amount),
        inferredCents: sum(
          expenses.filter((e) => e.source === "inferred"),
          (e) => e.original_amount,
        ),
        ambiguousCents: sum(
          expenses.filter((e) => e.source === "ambiguous"),
          (e) => e.original_amount,
        ),
        ambiguousCount: expenses.filter((e) => e.source === "ambiguous").length,
        openPayableCents: sum(counted, (e) => e.open_amount),
        lines: lineRows,
        expenses: expenses.map((e) => ({
          id: e.id,
          code: e.code,
          description: e.description,
          invoiceNumber: e.invoice_number,
          accountCode: e.account_code,
          accountName: e.account_name,
          supplierName: e.supplier_name,
          competencePeriod: e.competence_period,
          dueDate: e.due_date,
          status: e.status,
          originalAmountCents: Number(e.original_amount),
          settledAmountCents: Number(e.settled_amount),
          openAmountCents: Number(e.open_amount),
          source: e.source,
        })),
        quotas: {
          issuedCents,
          settledCents,
          openCents,
          collectionPct: issuedCents > 0 ? Math.round((settledCents / issuedCents) * 100) : 0,
          chargeCount: sum(units, (u) => u.charge_count),
          unitsTotal: units.length,
          unitsSettled: units.filter((u) => Number(u.open_cents) === 0).length,
          unitsPending: units.filter((u) => Number(u.open_cents) > 0).length,
          byUnit: units.map((u) => ({
            unitId: u.unit_id,
            designation: u.designation,
            chargeCount: Number(u.charge_count),
            issuedCents: Number(u.issued_cents),
            settledCents: Number(u.settled_cents),
            openCents: Number(u.open_cents),
          })),
        },
      };
    });

    return {
      id: head.assembly_id,
      type: head.assembly_type,
      minutesNumber: head.minutes_number,
      scheduledAt: head.scheduled_at,
      heldAt: head.held_at,
      status: head.assembly_status,
      budgets,
      totals: {
        budgetedCents: sum(budgets, (b) => b.budgetedCents),
        actualCents: sum(budgets, (b) => b.actualCents),
        issuedCents: sum(budgets, (b) => b.quotas.issuedCents),
        settledCents: sum(budgets, (b) => b.quotas.settledCents),
        openCents: sum(budgets, (b) => b.quotas.openCents),
        ambiguousCount: sum(budgets, (b) => b.ambiguousCount),
      },
    };
  });
}

type AssemblyExecution = Awaited<ReturnType<typeof buildAssemblies>>[number];

/** A lista não carrega o detalhe linha a linha - só os agregados. */
function stripDetail(a: AssemblyExecution) {
  return {
    ...a,
    budgets: a.budgets.map((b) => {
      const { expenses: _expenses, lines: _lines, quotas, ...rest } = b;
      const { byUnit: _byUnit, ...quotaRest } = quotas;
      return { ...rest, quotas: quotaRest };
    }),
  };
}

function sum<T>(rows: T[], pick: (row: T) => number | string): number {
  return rows.reduce((acc, row) => acc + Number(pick(row)), 0);
}
