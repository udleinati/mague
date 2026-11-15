// Pin dos contractos de buildDashboardState (agregação pura: top debtors,
// stats, buckets, ordenações, severity). Sem isto, mudanças de agregação
// partem o painel admin silenciosamente. Cobre também monthLabel e daysUntil.

import { assertEquals } from "@std/assert";
import {
  buildDashboardState,
  type DashboardInputs,
  daysUntil,
  monthLabel,
} from "./dashboard_state.ts";

const TODAY = new Date("2026-05-08T00:00:00Z");

// Factory de inputs com defaults vazios; testes sobrescrevem só o necessário.
function inputs(overrides: Partial<DashboardInputs> = {}): DashboardInputs {
  return {
    condominium: {},
    units: [],
    metrics: {
      paidThisMonthCents: 0,
      totalIssued: 0,
      totalPaidCount: 0,
      collectionRate: 0,
    },
    payables: [],
    bankActivity: { pendingCount: 0, txTotalCents: 0, activityByMonth: [] },
    assemblies: [],
    recurring: [],
    inspections: [],
    bankAccounts: [],
    tickets: [],
    today: TODAY,
    ...overrides,
  };
}

// ─── monthLabel ────────────────────────────────────────────────────────────

Deno.test("monthLabel: '2026-05' → 'Mai/26'", () => {
  assertEquals(monthLabel("2026-05"), "Mai/26");
});

Deno.test("monthLabel: '2026-01' → 'Jan/26' (mês 1, sem padding)", () => {
  assertEquals(monthLabel("2026-01"), "Jan/26");
});

Deno.test("monthLabel: '2026-12' → 'Dez/26'", () => {
  assertEquals(monthLabel("2026-12"), "Dez/26");
});

Deno.test("monthLabel: ano truncado para 2 dígitos", () => {
  assertEquals(monthLabel("2099-03"), "Mar/99");
});

// ─── daysUntil ─────────────────────────────────────────────────────────────

Deno.test("daysUntil: data futura é positiva", () => {
  const t = new Date("2026-05-01T00:00:00Z");
  assertEquals(daysUntil("2026-05-08", t), 7);
});

Deno.test("daysUntil: data passada é negativa", () => {
  const t = new Date("2026-05-08T00:00:00Z");
  assertEquals(daysUntil("2026-05-01", t), -7);
});

Deno.test("daysUntil: mesma data → 0", () => {
  const t = new Date("2026-05-08T00:00:00Z");
  assertEquals(daysUntil("2026-05-08", t), 0);
});

// ─── buildDashboardState - stats agregadas ────────────────────────────────

Deno.test("stats.unitsTotal = nº de items em units", () => {
  const s = buildDashboardState(inputs({
    units: [
      { id: "u1", designation: "A1" },
      { id: "u2", designation: "A2" },
    ],
  }));
  assertEquals(s.stats.unitsTotal, 2);
});

Deno.test("stats.occupants conta SÓ unit_occupant ativos (sem endDate)", () => {
  const s = buildDashboardState(inputs({
    units: [
      {
        id: "u1",
        designation: "A1",
        occupants: [
          { occupantId: "o1" }, // ativo
          { occupantId: "o2", endDate: null }, // ativo
          { occupantId: "o3", endDate: "2024-01-01" }, // saiu
        ],
      },
    ],
  }));
  assertEquals(s.stats.occupants, 2);
});

Deno.test("totalDebtCents = Σ openDebtCents de todas as units", () => {
  const s = buildDashboardState(inputs({
    units: [
      {
        id: "u1",
        designation: "A",
        balance: {
          openDebtCents: 10000,
          openCreditCents: 0,
          overdueDebtCents: 0,
          netCents: -10000,
        },
      },
      {
        id: "u2",
        designation: "B",
        balance: {
          openDebtCents: 25000,
          openCreditCents: 0,
          overdueDebtCents: 5000,
          netCents: -25000,
        },
      },
    ],
  }));
  assertEquals(s.stats.totalDebtCents, 35000);
  assertEquals(s.stats.overdueDebtCents, 5000);
  // future = total - overdue
  assertEquals(s.stats.futureDebtCents, 30000);
});

Deno.test("overdueCount = nº de units com overdueDebtCents > 0", () => {
  const s = buildDashboardState(inputs({
    units: [
      {
        id: "u1",
        designation: "A",
        balance: { openDebtCents: 100, openCreditCents: 0, overdueDebtCents: 50, netCents: -100 },
      },
      {
        id: "u2",
        designation: "B",
        balance: { openDebtCents: 100, openCreditCents: 0, overdueDebtCents: 0, netCents: -100 },
      },
      {
        id: "u3",
        designation: "C",
        balance: { openDebtCents: 100, openCreditCents: 0, overdueDebtCents: 1, netCents: -100 },
      },
    ],
  }));
  assertEquals(s.stats.overdueCount, 2);
});

Deno.test("totalPayableCents conta só payables em open/partial/overdue", () => {
  const s = buildDashboardState(inputs({
    payables: [
      { id: "p1", originalAmount: 100, openAmount: 100, status: "open" }, // conta
      { id: "p2", originalAmount: 100, openAmount: 50, status: "partial" }, // conta
      { id: "p3", originalAmount: 100, openAmount: 100, status: "overdue" }, // conta
      { id: "p4", originalAmount: 100, openAmount: 0, status: "paid" }, // ignora
      { id: "p5", originalAmount: 100, openAmount: 100, status: "cancelled" }, // ignora
    ],
  }));
  assertEquals(s.stats.totalPayableCents, 250);
});

// ─── topDebtors ────────────────────────────────────────────────────────────

Deno.test("topDebtors: ranking por valor em atraso, exclui sem atraso", () => {
  // "Cobranças a acompanhar" lista o VENCIDO (overdue), não o saldo em aberto:
  // fração com dívida só futura fica de fora. Valor mostrado = overdue, para
  // bater com a coluna "Em atraso" da listagem de frações.
  const s = buildDashboardState(inputs({
    units: [
      // openDebt alto (5000) mas 0 em atraso → excluída (só quotas futuras).
      {
        id: "u1",
        designation: "B",
        balance: { openDebtCents: 5000, openCreditCents: 0, overdueDebtCents: 0, netCents: -5000 },
      },
      // sem dívida nenhuma → excluída.
      {
        id: "u2",
        designation: "A",
        balance: { openDebtCents: 0, openCreditCents: 100, overdueDebtCents: 0, netCents: 100 },
      },
      // openDebt 30000 mas só 1000 vencido → amount mostrado = 1000 (overdue).
      {
        id: "u3",
        designation: "C",
        balance: {
          openDebtCents: 30000,
          openCreditCents: 0,
          overdueDebtCents: 1000,
          netCents: -30000,
        },
      },
      // menos openDebt que C mas mais vencido → fica à frente no ranking.
      {
        id: "u4",
        designation: "D",
        balance: {
          openDebtCents: 8000,
          openCreditCents: 0,
          overdueDebtCents: 8000,
          netCents: -8000,
        },
      },
    ],
  }));
  // Ordenado por overdue desc: D(8000) > C(1000). B e A fora (overdue=0).
  assertEquals(s.topDebtors.map((d) => d.designation), ["D", "C"]);
  // amount = overdueDebtCents, não openDebtCents (senão C viria com 30000).
  assertEquals(s.topDebtors[0].amount, 8000);
  assertEquals(s.topDebtors[1].amount, 1000);
});

// ─── Bank balance ─────────────────────────────────────────────────────────

Deno.test("bankBalance: opening + Σ tx vs ledger; diff = unreconciled", () => {
  const s = buildDashboardState(inputs({
    condominium: { bankBalance: { ordinaryCents: 700, fcrCents: 200, totalCents: 900 } },
    bankAccounts: [{ openingBalance: 1000 }, { openingBalance: 500 }],
    bankActivity: { pendingCount: 3, txTotalCents: -100, activityByMonth: [] },
  }));
  assertEquals(s.stats.bankBalanceCents, 1400); // 1500 + (-100)
  assertEquals(s.stats.bankBalanceLedgerCents, 900);
  // Pendente = físico - ledger.
  assertEquals(s.stats.bankBalanceUnreconciledCents, 500);
  assertEquals(s.stats.bankBalanceOrdinaryCents, 700);
  assertEquals(s.stats.bankBalanceFcrCents, 200);
  assertEquals(s.stats.pendingReconciliation, 3);
});

Deno.test("bankBalance: defaults seguros quando condominium.bankBalance ausente", () => {
  const s = buildDashboardState(inputs({})); // sem bankBalance
  assertEquals(s.stats.bankBalanceLedgerCents, 0);
  assertEquals(s.stats.bankBalanceOrdinaryCents, 0);
  assertEquals(s.stats.bankBalanceFcrCents, 0);
});

// ─── Bar chart maxBar ─────────────────────────────────────────────────────

Deno.test("maxBar: maior dos in/out across buckets; mínimo 1", () => {
  const s = buildDashboardState(inputs({
    bankActivity: {
      pendingCount: 0,
      txTotalCents: 0,
      activityByMonth: [
        { ym: "2026-03", label: "Mar/26", inCents: 1000, outCents: 500 },
        { ym: "2026-04", label: "Abr/26", inCents: 200, outCents: 8000 },
      ],
    },
  }));
  assertEquals(s.maxBar, 8000);
});

Deno.test("maxBar: sem buckets → 1 (evita divisão por zero no template)", () => {
  const s = buildDashboardState(inputs({}));
  assertEquals(s.maxBar, 1);
});

// ─── upcomingAssemblies ──────────────────────────────────────────────────

Deno.test("upcomingAssemblies: filtra held/cancelled e passadas; top 3", () => {
  const s = buildDashboardState(inputs({
    assemblies: [
      { id: "a1", type: "ordinary", status: "scheduled", scheduledAt: "2026-06-01" },
      { id: "a2", type: "ordinary", status: "held", scheduledAt: "2026-06-15" }, // ignora
      { id: "a3", type: "ordinary", status: "cancelled", scheduledAt: "2026-07-01" }, // ignora
      { id: "a4", type: "ordinary", status: "scheduled", scheduledAt: "2026-04-01" }, // passou
      { id: "a5", type: "ordinary", status: "scheduled", scheduledAt: "2026-05-15" },
      { id: "a6", type: "ordinary", status: "scheduled", scheduledAt: "2026-08-01" },
      { id: "a7", type: "ordinary", status: "scheduled", scheduledAt: "2026-09-01" }, // 4ª, fica fora
    ],
  }));
  assertEquals(s.upcomingAssemblies.length, 3);
  assertEquals(s.upcomingAssemblies[0].id, "a5");
  // daysUntil calculado para o 1º item (~7 dias).
  assertEquals(s.upcomingAssemblies[0].daysUntil, 7);
});

// ─── upcomingRecurring ───────────────────────────────────────────────────

Deno.test("upcomingRecurring: só ativos, top 4 ordenados por nextRunDate", () => {
  const s = buildDashboardState(inputs({
    recurring: [
      {
        id: "r1",
        description: "X",
        amount: 100,
        kind: "payable",
        nextRunDate: "2026-05-15",
        isActive: true,
        intervalType: "monthly",
      },
      {
        id: "r2",
        description: "Y",
        amount: 200,
        kind: "payable",
        nextRunDate: "2026-05-10",
        isActive: false,
        intervalType: "monthly",
      }, // ignora
      {
        id: "r3",
        description: "Z",
        amount: 300,
        kind: "payable",
        nextRunDate: "2026-05-12",
        isActive: true,
        intervalType: "monthly",
      },
    ],
  }));
  assertEquals(s.upcomingRecurring.map((r) => r.id), ["r3", "r1"]);
});

// ─── openTickets ─────────────────────────────────────────────────────────

Deno.test("openTickets: top 4 mais recentes com severity + unit label", () => {
  const s = buildDashboardState(inputs({
    units: [{ id: "u1", designation: "1ºA" }],
    tickets: [
      {
        id: "t1",
        code: "T001",
        title: "X",
        location: null,
        priority: "urgent",
        status: "open",
        createdAt: "2026-05-08T00:00:00Z",
        unitId: "u1",
      },
      {
        id: "t2",
        code: "T002",
        title: "Y",
        location: null,
        priority: "low",
        status: "open",
        createdAt: "2026-05-07T00:00:00Z",
        unitId: null,
      },
      {
        id: "t3",
        code: "T003",
        title: "Z",
        location: "Hall",
        priority: "high",
        status: "open",
        createdAt: "2026-05-06T00:00:00Z",
        unitId: null,
      },
    ],
  }));
  // Ordenado createdAt DESC.
  assertEquals(s.openTickets.map((t) => t.id), ["t1", "t2", "t3"]);
  // Severity mapping.
  assertEquals(s.openTickets[0].severity, "high"); // urgent → high
  assertEquals(s.openTickets[1].severity, "low");
  assertEquals(s.openTickets[2].severity, "high");
  // Label da unit (t1 com unitId) vs location (t3 sem unitId mas com location)
  // vs default "Zona comum" (t2 sem ambos).
  assertEquals(s.openTickets[0].unit, "1ºA");
  assertEquals(s.openTickets[1].unit, "Zona comum");
  assertEquals(s.openTickets[2].unit, "Hall");
});

Deno.test("openTickets.openedDaysAgo: 0 se hoje, positivo se passado, nunca negativo", () => {
  const s = buildDashboardState(inputs({
    tickets: [
      {
        id: "t1",
        code: "T001",
        title: "Hoje",
        location: null,
        priority: "normal",
        status: "open",
        createdAt: "2026-05-08T00:00:00Z",
        unitId: null,
      },
      {
        id: "t2",
        code: "T002",
        title: "Ontem",
        location: null,
        priority: "normal",
        status: "open",
        createdAt: "2026-05-07T00:00:00Z",
        unitId: null,
      },
    ],
  }));
  assertEquals(s.openTickets[0].openedDaysAgo, 0);
  assertEquals(s.openTickets[1].openedDaysAgo, 1);
});

Deno.test("totalOpenTickets reflete inputs.tickets.length (não trunca)", () => {
  const tickets = Array.from({ length: 10 }, (_, i) => ({
    id: `t${i}`,
    code: `T${String(i + 1).padStart(3, "0")}`,
    title: "X",
    location: null,
    priority: "normal",
    status: "open",
    createdAt: "2026-01-01",
    unitId: null,
  }));
  const s = buildDashboardState(inputs({ tickets }));
  assertEquals(s.totalOpenTickets, 10);
  assertEquals(s.openTickets.length, 4); // truncado a 4
});

// ─── upcomingInspections ─────────────────────────────────────────────────

Deno.test("upcomingInspections: só ativas, top 6, com category labels PT", () => {
  const s = buildDashboardState(inputs({
    inspections: [
      {
        id: "i1",
        category: "elevator",
        description: "X",
        validUntil: "2026-06-01",
        isActive: true,
        status: null,
      },
      {
        id: "i2",
        category: "fire_extinguisher",
        description: "Y",
        validUntil: "2026-05-15",
        isActive: false,
        status: null,
      },
      {
        id: "i3",
        category: "gas",
        description: "Z",
        validUntil: "2026-05-20",
        isActive: true,
        status: "valid",
      },
    ],
  }));
  assertEquals(s.upcomingInspections.length, 2);
  // Ordenado por validUntil ASC.
  assertEquals(s.upcomingInspections[0].id, "i3");
  // Category label PT.
  assertEquals(s.upcomingInspections[0].categoryLabel, "Gás");
  assertEquals(s.upcomingInspections[1].categoryLabel, "Elevador");
});

Deno.test("upcomingInspections.relativeWhen: vencida vs futuro vs hoje", () => {
  const s = buildDashboardState(inputs({
    inspections: [
      {
        id: "p",
        category: "other",
        description: "Passada",
        validUntil: "2026-04-01",
        isActive: true,
        status: null,
      },
      {
        id: "h",
        category: "other",
        description: "Hoje",
        validUntil: "2026-05-08",
        isActive: true,
        status: null,
      },
      {
        id: "a",
        category: "other",
        description: "Amanhã",
        validUntil: "2026-05-09",
        isActive: true,
        status: null,
      },
      {
        id: "f",
        category: "other",
        description: "Futuro",
        validUntil: "2026-06-01",
        isActive: true,
        status: null,
      },
    ],
  }));
  // sorted by validUntil ASC: p, h, a, f.
  assertEquals(s.upcomingInspections.map((i) => i.relativeWhen), [
    "vencida há 37 d",
    "vence hoje",
    "vence amanhã",
    "daqui a 24 d",
  ]);
});

Deno.test("category desconhecido → label fallback é o próprio category", () => {
  const s = buildDashboardState(inputs({
    inspections: [{
      id: "i1",
      category: "exotic",
      description: "X",
      validUntil: "2026-06-01",
      isActive: true,
      status: null,
    }],
  }));
  assertEquals(s.upcomingInspections[0].categoryLabel, "exotic");
});
