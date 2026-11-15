// Dashboard do panel admin - orquestra fetch das ~10 fontes e delega o
// shape do output a `dashboard_state.ts` (função pura testável). Input
// tipado explicitamente (casts inline omitiam campos e passavam com `any`).

import { render } from "$panel/render.ts";
import {
  type AssemblyForDashboard,
  type BankAccountForDashboard,
  type BankActivitySummary,
  buildDashboardState,
  type CondominiumWithBankBalance,
  type DashboardMetrics,
  type InspectionForDashboard,
  type RecurringTplForDashboard,
  type TicketForDashboard,
  type UnitWithBalance,
} from "./dashboard_state.ts";
import { client } from "$panel/client.ts";
import { requireCurrentCondominium } from "$panel/condominium.ts";

export async function dashboard() {
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const currentMonth = todayIso.slice(0, 7);
  const currentYear = String(today.getFullYear());

  // ── Pushdowns para reduzir dataset trazido ─────────────────────────────
  // metrics/bankActivity agregam em SQL; payables só open_any; assemblies só
  // scheduled; inspections lite=1; tickets = open + in_progress merged.
  const [
    condominium,
    unitsR,
    metricsR,
    payablesR,
    bankActivityR,
    assembliesR,
    recurringR,
    inspectionsR,
    bankAccountsR,
    ticketsR,
  ] = await Promise.all([
    requireCurrentCondominium(),
    client.admin.listUnits() as unknown as Promise<{ data: UnitWithBalance[] }>,
    client.admin.dashboardMetrics({ year: currentYear, month: currentMonth }).catch(() => ({
      data: {
        paidThisMonthCents: 0,
        totalIssued: 0,
        totalPaidCount: 0,
        collectionRate: 0,
      } as DashboardMetrics,
    })),
    client.admin.listCharges({ kind: "payable", status: "open_any" }).catch(() => ({ data: [] })),
    client.admin.bankActivitySummary().catch(() => ({
      data: {
        pendingCount: 0,
        txTotalCents: 0,
        activityByMonth: [],
      } as BankActivitySummary,
    })),
    client.admin.listAssemblies({ status: "scheduled" }).catch(() => ({ data: [] })),
    client.admin.listRecurringTemplates().catch(() => ({ data: [] })),
    client.admin.listInspections({ lite: "1" }).catch(() => ({ data: [] })),
    client.admin.listBankAccounts().catch(() => ({ data: [] })),
    Promise.all([
      client.admin.listTickets({ status: "open" }).catch(() => ({ data: [] })),
      client.admin.listTickets({ status: "in_progress" }).catch(() => ({ data: [] })),
    ]).then(([a, b]) => ({ data: [...(a.data ?? []), ...(b.data ?? [])] })),
  ]);

  // Lembretes de cobrança (ADR 0028). Catch -> 0 para nunca partir o dashboard.
  const billingOverdueRes = await client.admin.listBillingOverdueUnits().catch(() => ({
    data: { reconciledThroughDate: null, guard: { ok: false }, units: [] },
  }));
  const billingOverdueCount = billingOverdueRes.data.units.length;
  const billingGuardOk = billingOverdueRes.data.guard.ok;

  const state = buildDashboardState({
    condominium: condominium as unknown as CondominiumWithBankBalance,
    units: unitsR.data,
    metrics: metricsR.data,
    payables: payablesR.data,
    bankActivity: bankActivityR.data,
    assemblies: assembliesR.data as unknown as AssemblyForDashboard[],
    recurring: recurringR.data as unknown as RecurringTplForDashboard[],
    inspections: inspectionsR.data as unknown as InspectionForDashboard[],
    bankAccounts: bankAccountsR.data as unknown as BankAccountForDashboard[],
    tickets: (ticketsR.data ?? []) as unknown as TicketForDashboard[],
    today,
  });

  return await render("pages/dashboard.vto", {
    title: "Painel",
    section: "dashboard",
    billingOverdueCount,
    billingGuardOk,
    ...state,
  });
}
