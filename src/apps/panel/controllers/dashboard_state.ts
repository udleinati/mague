// Builder puro que transforma respostas da API em `DashboardState`. Separado
// do fetching para tipar `DashboardInputs` (uma fonte de verdade) e ser
// testável sem mockar fetch.

const OPEN_STATUSES = new Set(["open", "partial", "overdue"]);

const MONTH_NAMES = [
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
] as const;

const CATEGORY_LABELS: Record<string, string> = {
  fire_extinguisher: "Extintores",
  fire_detection: "Detecção de incêndio",
  elevator: "Elevador",
  gas: "Gás",
  electricity: "Instalação elétrica",
  lightning_rod: "Pára-raios",
  hvac: "AVAC",
  pool: "Piscina",
  antenna: "Antena",
  other: "Outros",
};

// ─── Helpers puros ──────────────────────────────────────────────────────

export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]}/${String(y).slice(2)}`;
}

export function daysUntil(iso: string, today: Date = new Date()): number {
  const d = new Date(iso);
  return Math.ceil((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

function ticketSeverity(priority: string): "high" | "medium" | "low" {
  if (priority === "urgent" || priority === "high") return "high";
  if (priority === "medium") return "medium";
  return "low";
}

function inspectionRelativeWhen(days: number): string {
  if (days < 0) return `vencida há ${-days} d`;
  if (days === 0) return "vence hoje";
  if (days === 1) return "vence amanhã";
  return `daqui a ${days} d`;
}

// ─── Inputs (espelham as respostas da API que o dashboard consome) ─────

export interface UnitWithBalance {
  id: string;
  designation: string;
  identifier?: string | null;
  occupants?: Array<{ occupantId: string; endDate?: string | null }>;
  balance?: {
    openDebtCents: number;
    openCreditCents: number;
    overdueDebtCents: number;
    netCents: number;
  };
}

export interface ChargeForDashboard {
  id: string;
  unitId?: string | null;
  scope?: string;
  nature?: string;
  originalAmount: number;
  openAmount: number;
  status: string;
  dueDate?: string | null;
  description?: string;
  competencePeriod?: string | null;
  chargeType?: string;
}

export interface AssemblyForDashboard {
  id: string;
  type: string;
  status: string;
  scheduledAt: string;
  minutesNumber?: string | null;
}

export interface RecurringTplForDashboard {
  id: string;
  description: string;
  amount: number;
  kind: string;
  nextRunDate: string;
  isActive: boolean;
  intervalType: string;
}

export interface InspectionForDashboard {
  id: string;
  category: string;
  description: string;
  validUntil: string;
  isActive: boolean;
  status: string | null;
}

export interface BankAccountForDashboard {
  openingBalance?: number | null;
}

export interface BankActivitySummary {
  pendingCount: number;
  txTotalCents: number;
  activityByMonth: Array<{ ym: string; label: string; inCents: number; outCents: number }>;
}

export interface DashboardMetrics {
  paidThisMonthCents: number;
  totalIssued: number;
  totalPaidCount: number;
  collectionRate: number;
}

export interface CondominiumWithBankBalance {
  bankBalance?: {
    ordinaryCents: number;
    fcrCents: number;
    totalCents: number;
  };
}

export interface TicketForDashboard {
  id: string;
  code: string;
  title: string;
  location: string | null;
  priority: string;
  status: string;
  createdAt: string;
  unitId: string | null;
}

export interface DashboardInputs {
  condominium: CondominiumWithBankBalance;
  units: UnitWithBalance[];
  metrics: DashboardMetrics;
  payables: ChargeForDashboard[];
  bankActivity: BankActivitySummary;
  assemblies: AssemblyForDashboard[];
  recurring: RecurringTplForDashboard[];
  inspections: InspectionForDashboard[];
  bankAccounts: BankAccountForDashboard[];
  tickets: TicketForDashboard[];
  /** Today em ISO (YYYY-MM-DD). Override em testes para reprodutibilidade. */
  today?: Date;
}

// ─── Output (forma exposta ao template) ─────────────────────────────────

export interface DashboardState {
  stats: {
    unitsTotal: number;
    occupants: number;
    totalDebtCents: number;
    overdueDebtCents: number;
    futureDebtCents: number;
    overdueCount: number;
    totalPayableCents: number;
    paidThisMonthCents: number;
    collectionRate: number;
    bankBalanceCents: number;
    bankBalanceLedgerCents: number;
    bankBalanceOrdinaryCents: number;
    bankBalanceFcrCents: number;
    bankBalanceUnreconciledCents: number;
    pendingReconciliation: number;
  };
  topDebtors: Array<{
    unitId: string;
    designation: string;
    identifier: string | null;
    amount: number;
  }>;
  monthBuckets: BankActivitySummary["activityByMonth"];
  maxBar: number;
  upcomingAssemblies: Array<AssemblyForDashboard & { daysUntil: number }>;
  upcomingRecurring: Array<RecurringTplForDashboard & { daysUntil: number }>;
  openTickets: Array<{
    id: string;
    code: string;
    title: string;
    unit: string;
    severity: "high" | "medium" | "low";
    openedDaysAgo: number;
  }>;
  totalOpenTickets: number;
  upcomingInspections: Array<{
    id: string;
    category: string;
    categoryLabel: string;
    description: string;
    validUntil: string;
    status: string | null;
    relativeWhen: string;
  }>;
}

// ─── Builder ────────────────────────────────────────────────────────────

export function buildDashboardState(inputs: DashboardInputs): DashboardState {
  const today = inputs.today ?? new Date();
  const todayIso = today.toISOString().slice(0, 10);

  const balances = inputs.condominium.bankBalance ??
    { ordinaryCents: 0, fcrCents: 0, totalCents: 0 };

  // Frações / ocupantes - conta unit_occupant ativos (sem endDate).
  const activeOccupantLinks = inputs.units.reduce(
    (s, u) => s + (u.occupants ?? []).filter((o) => !o.endDate).length,
    0,
  );

  // Dívida agregada - separa "em atraso" (due_date passado) de "futura"
  // (lançada mas dentro do prazo). Vem da view v_unit_balance.
  const totalDebtCents = inputs.units.reduce(
    (s, u) => s + (u.balance?.openDebtCents ?? 0),
    0,
  );
  const overdueDebtCents = inputs.units.reduce(
    (s, u) => s + (u.balance?.overdueDebtCents ?? 0),
    0,
  );
  const futureDebtCents = totalDebtCents - overdueDebtCents;
  const overdueCount = inputs.units.filter(
    (u) => (u.balance?.overdueDebtCents ?? 0) > 0,
  ).length;

  // Despesas (payable) em aberto - soma só as que estão a pagar.
  const openPayable = inputs.payables.filter((c) => OPEN_STATUSES.has(c.status));
  const totalPayableCents = openPayable.reduce(
    (s, c) => s + Number(c.openAmount || 0),
    0,
  );

  // Usa overdueDebtCents (não openDebtCents): só dívida vencida é "a
  // acompanhar"; quotas futuras lançadas mas por vencer não entram.
  const topDebtors = inputs.units
    .filter((u) => (u.balance?.overdueDebtCents ?? 0) > 0)
    .map((u) => ({
      unitId: u.id,
      designation: u.designation,
      identifier: u.identifier ?? null,
      amount: u.balance!.overdueDebtCents,
    }))
    .sort((a, b) => b.amount - a.amount);

  // Banco - saldo físico (opening + Σ tx) vs ledger (v_bank_balance).
  // Diferença = pendente de conciliação.
  const openingTotalCents = inputs.bankAccounts.reduce(
    (s, a) => s + Number(a.openingBalance ?? 0),
    0,
  );
  const bankTxTotalCents = inputs.bankActivity.txTotalCents;
  const bankBalanceCents = openingTotalCents + bankTxTotalCents;
  const bankBalanceLedgerCents = balances.totalCents;
  const bankBalanceUnreconciledCents = bankBalanceCents - bankBalanceLedgerCents;

  // Gráfico 6m - escala vem do max bucket.
  const monthBuckets = inputs.bankActivity.activityByMonth;
  const maxBar = Math.max(
    1,
    ...monthBuckets.map((b) => Math.max(b.inCents, b.outCents)),
  );

  // Próximas assembleias (não held/cancelled, futuras, top 3).
  const upcomingAssemblies = inputs.assemblies
    .filter(
      (a) =>
        a.status !== "held" &&
        a.status !== "cancelled" &&
        a.scheduledAt >= todayIso,
    )
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
    .slice(0, 3)
    .map((a) => ({ ...a, daysUntil: daysUntil(a.scheduledAt, today) }));

  // Recurring ativos a gerar em breve (top 4 por nextRunDate).
  const upcomingRecurring = inputs.recurring
    .filter((r) => r.isActive)
    .sort((a, b) => a.nextRunDate.localeCompare(b.nextRunDate))
    .slice(0, 4)
    .map((r) => ({ ...r, daysUntil: daysUntil(r.nextRunDate, today) }));

  // Tickets abertos (top 4 mais recentes) com severity + label da unit.
  const unitDesignationById = new Map<string, string>(
    inputs.units.map((u) => [u.id, u.designation]),
  );
  const openTickets = [...inputs.tickets]
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 4)
    .map((t) => {
      const where = t.unitId
        ? (unitDesignationById.get(t.unitId) ?? "Fração")
        : (t.location || "Zona comum");
      return {
        id: t.id,
        code: t.code,
        title: t.title,
        unit: where,
        severity: ticketSeverity(t.priority),
        openedDaysAgo: Math.max(0, -daysUntil(t.createdAt, today)),
      };
    });

  // Próximas inspeções (top 6 ativas mais próximas de vencer).
  const upcomingInspections = inputs.inspections
    .filter((i) => i.isActive)
    .sort((a, b) => a.validUntil.localeCompare(b.validUntil))
    .slice(0, 6)
    .map((i) => ({
      id: i.id,
      category: i.category,
      categoryLabel: CATEGORY_LABELS[i.category] ?? i.category,
      description: i.description,
      validUntil: i.validUntil,
      status: i.status,
      relativeWhen: inspectionRelativeWhen(daysUntil(i.validUntil, today)),
    }));

  return {
    stats: {
      unitsTotal: inputs.units.length,
      occupants: activeOccupantLinks,
      totalDebtCents,
      overdueDebtCents,
      futureDebtCents,
      overdueCount,
      totalPayableCents,
      paidThisMonthCents: inputs.metrics.paidThisMonthCents,
      collectionRate: inputs.metrics.collectionRate,
      bankBalanceCents,
      bankBalanceLedgerCents,
      bankBalanceOrdinaryCents: balances.ordinaryCents,
      bankBalanceFcrCents: balances.fcrCents,
      bankBalanceUnreconciledCents,
      pendingReconciliation: inputs.bankActivity.pendingCount,
    },
    topDebtors,
    monthBuckets,
    maxBar,
    upcomingAssemblies,
    upcomingRecurring,
    openTickets,
    totalOpenTickets: inputs.tickets.length,
    upcomingInspections,
  };
}
