import { type AsyncResult } from "../http.ts";
import { ManagerResource } from "../admin.ts";

export interface CashMovementEvent {
  id: string;
  date: string;
  month: string;
  entryType: string;
  entryTypeLabel: string;
  description: string;
  refType: string | null;
  refId: string | null;
  counterpartCodes: string[];
  counterpartNames: string[];
  ordinaryCents: number;
  fcrCents: number;
  totalCents: number;
  ordinaryBalanceCents: number;
  fcrBalanceCents: number;
  totalBalanceCents: number;
}

export interface CashMovementsReport {
  year: number;
  availableYears: number[];
  opening: { ordinaryCents: number; fcrCents: number; totalCents: number };
  closing: { ordinaryCents: number; fcrCents: number; totalCents: number };
  totals: {
    ordinaryInCents: number;
    ordinaryOutCents: number;
    fcrInCents: number;
    fcrOutCents: number;
    inCents: number;
    outCents: number;
  };
  months: Array<{
    month: string;
    ordinaryInCents: number;
    ordinaryOutCents: number;
    fcrInCents: number;
    fcrOutCents: number;
    ordinaryClosingCents: number;
    fcrClosingCents: number;
    totalClosingCents: number;
    hasMovements: boolean;
  }>;
  byAccount: Array<{
    code: string;
    name: string;
    inCents: number;
    outCents: number;
    count: number;
  }>;
  events: CashMovementEvent[];
}

export interface CashflowRow {
  key: string;
  kind: "overdue" | "month" | "later";
  month: string | null;
  chargeInCents: number;
  chargeOutCents: number;
  chargeInFcrCents: number;
  chargeOutFcrCents: number;
  chargeInCount: number;
  chargeOutCount: number;
  recurringInCents: number;
  recurringOutCents: number;
  inCents: number;
  outCents: number;
  inFcrCents: number;
  outFcrCents: number;
  netCents: number;
  closingOrdinaryCents: number;
  closingFcrCents: number;
  closingCents: number;
}

export interface CashflowReport {
  today: string;
  horizonMonths: number;
  horizonEnd: string;
  balance: { ordinaryCents: number; fcrCents: number; totalCents: number };
  unusedCredits: { openCents: number; count: number };
  rows: CashflowRow[];
  recurring: Array<{
    id: string;
    kind: string;
    description: string;
    amountCents: number;
    intervalType: string;
    nextRunDate: string;
    endDate: string | null;
    occurrencesInHorizon: number;
  }>;
  totals: {
    inCents: number;
    outCents: number;
    inFcrCents: number;
    outFcrCents: number;
    netCents: number;
    projectedClosingOrdinaryCents: number;
    projectedClosingFcrCents: number;
    projectedClosingCents: number;
  };
}

export interface AssemblyBudgetExecution {
  id: string;
  year: string;
  type: string;
  status: string;
  installments: number | null;
  approvedAt: string | null;
  agendaItem: { id: string; sequence: number; subject: string; approved: boolean | null };
  budgetedCents: number;
  actualCents: number;
  varianceCents: number;
  executionPct: number;
  taggedCents: number;
  inferredCents: number;
  ambiguousCents: number;
  ambiguousCount: number;
  openPayableCents: number;
  lines?: Array<{
    accountId: string;
    accountCode: string;
    accountName: string;
    budgetedCents: number;
    actualCents: number;
    varianceCents: number;
    chargeCount: number;
    ambiguous: boolean;
  }>;
  expenses?: Array<{
    id: string;
    code: string | null;
    description: string;
    invoiceNumber: string | null;
    accountCode: string | null;
    accountName: string | null;
    supplierName: string | null;
    competencePeriod: string;
    dueDate: string | null;
    status: string;
    originalAmountCents: number;
    settledAmountCents: number;
    openAmountCents: number;
    source: "tagged" | "inferred" | "ambiguous";
  }>;
  quotas: {
    issuedCents: number;
    settledCents: number;
    openCents: number;
    collectionPct: number;
    chargeCount: number;
    unitsTotal: number;
    unitsSettled: number;
    unitsPending: number;
    byUnit?: Array<{
      unitId: string;
      designation: string;
      chargeCount: number;
      issuedCents: number;
      settledCents: number;
      openCents: number;
    }>;
  };
}

export interface AssemblyExecution {
  id: string;
  type: string;
  minutesNumber: string | null;
  scheduledAt: string;
  heldAt: string | null;
  status: string;
  budgets: AssemblyBudgetExecution[];
  totals: {
    budgetedCents: number;
    actualCents: number;
    issuedCents: number;
    settledCents: number;
    openCents: number;
    ambiguousCount: number;
  };
}

declare module "../admin.ts" {
  interface ManagerResource {
    cashMovementsReport(
      params?: { year?: string | number },
      requestInit?: RequestInit,
    ): AsyncResult<CashMovementsReport>;
    cashflowReport(
      params?: { months?: string | number },
      requestInit?: RequestInit,
    ): AsyncResult<CashflowReport>;
    assemblyExecutionReport(
      requestInit?: RequestInit,
    ): AsyncResult<{ assemblies: AssemblyExecution[] }>;
    assemblyExecutionDetail(
      assemblyId: string,
      requestInit?: RequestInit,
    ): AsyncResult<AssemblyExecution>;
  }
}

/** Relatórios agregados (leitura). Ver modules/admin/report/ na API. */
export function registerReportMethods(): void {
  ManagerResource.prototype.cashMovementsReport = function (params, requestInit) {
    const qs = params?.year ? `?year=${encodeURIComponent(String(params.year))}` : "";
    return this.request<CashMovementsReport>("GET", `/reports/cash-movements${qs}`, requestInit);
  };

  ManagerResource.prototype.cashflowReport = function (params, requestInit) {
    const qs = params?.months ? `?months=${encodeURIComponent(String(params.months))}` : "";
    return this.request<CashflowReport>("GET", `/reports/cashflow${qs}`, requestInit);
  };

  ManagerResource.prototype.assemblyExecutionReport = function (requestInit) {
    return this.request<{ assemblies: AssemblyExecution[] }>(
      "GET",
      "/reports/assembly-execution",
      requestInit,
    );
  };

  ManagerResource.prototype.assemblyExecutionDetail = function (assemblyId, requestInit) {
    return this.request<AssemblyExecution>(
      "GET",
      `/reports/assembly-execution/${assemblyId}`,
      requestInit,
    );
  };
}
