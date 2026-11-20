// Smoke tests de render dos 3 relatórios. Sem BD/API - render puro com dados
// mock (mesmo harness de fcr_transfer_views_test). Cada teste fixa uma
// afirmação que o admin lê no ecrã e sobre a qual decide.

import { assert, assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";
import { testAdminNav } from "./_admin_nav_fixture.ts";

// ─── Movimentos do ano ─────────────────────────────────────────────────────

const movementsCtx = (over: Record<string, unknown> = {}) => ({
  currentCondominiumId: "c1",
  adminNav: testAdminNav,
  title: "Movimentos do ano",
  section: "report_movements",
  report: {
    year: 2026,
    availableYears: [2026, 2025],
    opening: { ordinaryCents: 100000, fcrCents: 200000, totalCents: 300000 },
    closing: { ordinaryCents: 150000, fcrCents: 120000, totalCents: 270000 },
    totals: {
      ordinaryInCents: 90000,
      ordinaryOutCents: 40000,
      fcrInCents: 10000,
      fcrOutCents: 90000,
      inCents: 100000,
      outCents: 130000,
    },
    byAccount: [{
      code: "2111",
      name: "Condóminos - Quotas Ordinárias",
      inCents: 90000,
      outCents: 0,
      count: 12,
    }],
    events: [],
  },
  months: [{
    month: "2026-01",
    label: "Janeiro 2026",
    ordinaryInCents: 90000,
    ordinaryOutCents: 40000,
    fcrInCents: 10000,
    fcrOutCents: 90000,
    ordinaryClosingCents: 150000,
    fcrClosingCents: 120000,
    totalClosingCents: 270000,
    hasMovements: true,
  }],
  events: [{
    id: "e1",
    date: "2026-01-20",
    month: "2026-01",
    entryType: "fcrTransfer",
    entryTypeLabel: "Transferência entre bolsas",
    description: "Transferência da bolsa FCR para ordinária",
    refType: "fcr_transfer",
    refId: "t1",
    counterpartCodes: [],
    counterpartNames: [],
    ordinaryCents: 80000,
    fcrCents: -80000,
    totalCents: 0,
    ordinaryBalanceCents: 150000,
    fcrBalanceCents: 120000,
    totalBalanceCents: 270000,
  }],
  filterBolsa: "all",
  filterMonth: null,
  filterMonthLabel: "",
  filtered: { inCents: 0, outCents: 0 },
  isFiltered: false,
  ...over,
});

Deno.test("movimentos: a transferência entre bolsas aparece como movimento", async () => {
  // É a pergunta que originou o relatório: "onde vejo a movimentação de FCR
  // para ordinária que fiz?". Se não estiver na lista, o relatório falhou.
  const html = await render("pages/reports/movements.vto", movementsCtx());
  assertStringIncludes(html, "Transferência entre bolsas");
  // Sinais opostos nas duas bolsas: entra na ordinária, sai do FCR.
  assertStringIncludes(html, "800,00 €");
  assertStringIncludes(html, "-800,00 €");
});

Deno.test("movimentos: saldo de abertura e de fecho das duas bolsas", async () => {
  // Um extrato sem saldo inicial não fecha contra o extrato do banco.
  const html = await render("pages/reports/movements.vto", movementsCtx());
  assertStringIncludes(html, "Saldo em 1 de Janeiro");
  assertStringIncludes(html, "Saldo em 31 de Dezembro");
  assertStringIncludes(html, "Bolsa ordinária");
  assertStringIncludes(html, "Bolsa FCR");
  assertStringIncludes(html, "3.000,00 €");
  assertStringIncludes(html, "2.700,00 €");
});

Deno.test("movimentos: sem eventos no filtro, diz-se em vez de mostrar tabela vazia", async () => {
  const html = await render("pages/reports/movements.vto", movementsCtx({ events: [] }));
  assertStringIncludes(html, "Sem movimentos para este filtro");
});

// ─── Previsão de tesouraria ────────────────────────────────────────────────

const cashflowRow = (over: Record<string, unknown> = {}) => ({
  key: "2026-09",
  kind: "month",
  month: "2026-09",
  label: "Setembro 2026",
  chargeInCents: 0,
  chargeOutCents: 0,
  chargeInFcrCents: 0,
  chargeOutFcrCents: 0,
  chargeInCount: 0,
  chargeOutCount: 0,
  recurringInCents: 0,
  recurringOutCents: 0,
  inCents: 0,
  outCents: 0,
  inFcrCents: 0,
  outFcrCents: 0,
  netCents: 0,
  closingOrdinaryCents: 80000,
  closingFcrCents: 20000,
  closingCents: 100000,
  inPct: 0,
  outPct: 0,
  ...over,
});

const cashflowCtx = (over: Record<string, unknown> = {}) => ({
  currentCondominiumId: "c1",
  adminNav: testAdminNav,
  title: "Previsão de tesouraria",
  section: "report_cashflow",
  horizonMonths: 12,
  report: {
    today: "2026-08-21",
    horizonMonths: 12,
    horizonEnd: "2027-07-31",
    balance: { ordinaryCents: 80000, fcrCents: 20000, totalCents: 100000 },
    unusedCredits: { openCents: 5000, count: 2 },
    recurring: [],
    totals: {
      inCents: 60000,
      outCents: 30000,
      inFcrCents: 4000,
      outFcrCents: 0,
      netCents: 30000,
      projectedClosingOrdinaryCents: 100000,
      projectedClosingFcrCents: 30000,
      projectedClosingCents: 130000,
    },
  },
  rows: [
    cashflowRow({
      key: "overdue",
      kind: "overdue",
      month: null,
      label: "Em atraso",
      inCents: 40000,
      inFcrCents: 4000,
      netCents: 40000,
      closingOrdinaryCents: 116000,
      closingFcrCents: 24000,
      closingCents: 140000,
      inPct: 100,
    }),
    cashflowRow({
      outCents: 20000,
      netCents: -20000,
      closingOrdinaryCents: 96000,
      closingFcrCents: 24000,
      closingCents: 120000,
      outPct: 50,
    }),
  ],
  worst: null,
  hasNegative: false,
  ...over,
});

Deno.test("tesouraria: o vencido tem linha própria e conta no saldo projetado", async () => {
  // Misturar vencido com o mês corrente escondia a dívida antiga. Separado,
  // o admin vê quanto do saldo projetado depende de cobrar atrasos.
  const html = await render("pages/reports/cashflow.vto", cashflowCtx());
  assertStringIncludes(html, "Em atraso");
  assertStringIncludes(html, "já vencido");
  assertStringIncludes(html, "1.400,00 €");
});

Deno.test("tesouraria: ruptura de caixa é avisada, não deixada para procurar", async () => {
  // O único alarme real deste relatório. Sem o aviso, o admin tinha de
  // percorrer 12 linhas para descobrir que Março fica negativo.
  const html = await render(
    "pages/reports/cashflow.vto",
    cashflowCtx({
      hasNegative: true,
      worst: cashflowRow({ label: "Março 2027", closingCents: -50000 }),
    }),
  );
  assertStringIncludes(html, "A tesouraria fica negativa em Março 2027");
  assertStringIncludes(html, "-500,00 €");
});

Deno.test("tesouraria: o saldo projetado separa a bolsa ordinária da FCR", async () => {
  // O FCR é dinheiro carimbado (art. 1424.º-A): só entra, e as saídas descem
  // sempre da ordinária. Num total único, o admin lê caixa que não pode gastar
  // - por isso a despesa de 200 € tira à ordinária e deixa o FCR a subir.
  const html = await render("pages/reports/cashflow.vto", cashflowCtx());
  assertStringIncludes(html, "Saldo ord.");
  assertStringIncludes(html, "Saldo FCR");
  assertStringIncludes(html, "1.160,00 €");
  assertStringIncludes(html, "960,00 €");
  assertStringIncludes(html, "240,00 €");
  assertStringIncludes(html, "ordinária 1.000,00 € · FCR 300,00 €");
});

Deno.test("tesouraria: declara o que não conta (créditos por usar)", async () => {
  // Sem isto, as entradas previstas leem-se como certas. Os créditos das
  // frações abatem em quotas futuras e nunca chegam ao banco.
  const html = await render("pages/reports/cashflow.vto", cashflowCtx());
  assertStringIncludes(html, "Créditos de frações por usar");
  assertStringIncludes(html, "50,00 €");
  assertStringIncludes(html, "Quotas ainda por gerar");
});

// ─── Execução por Ata ──────────────────────────────────────────────────────

const budgetExec = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  year: "2026",
  type: "suplementar",
  status: "approved",
  installments: 3,
  approvedAt: "2026-06-20",
  agendaItem: {
    id: "ai1",
    sequence: 2,
    subject: "Aprovação do orçamento suplementar",
    approved: true,
  },
  budgetedCents: 3000000,
  actualCents: 2580000,
  varianceCents: 420000,
  executionPct: 86,
  taggedCents: 0,
  inferredCents: 2580000,
  ambiguousCents: 0,
  ambiguousCount: 0,
  openPayableCents: 0,
  quotas: {
    issuedCents: 3000000,
    settledCents: 1590000,
    openCents: 1410000,
    collectionPct: 53,
    chargeCount: 120,
    unitsTotal: 40,
    unitsSettled: 10,
    unitsPending: 30,
  },
  ...over,
});

const assembliesCtx = (over: Record<string, unknown> = {}) => ({
  currentCondominiumId: "c1",
  adminNav: testAdminNav,
  title: "Execução por Ata",
  section: "report_assemblies",
  assemblies: [{
    id: "a12",
    type: "extraordinary",
    minutesNumber: "12",
    scheduledAt: "2026-06-10",
    heldAt: "2026-06-20",
    status: "held",
    budgets: [budgetExec()],
    totals: {
      budgetedCents: 3000000,
      actualCents: 2580000,
      issuedCents: 3000000,
      settledCents: 1590000,
      openCents: 1410000,
      ambiguousCount: 0,
    },
  }],
  ...over,
});

Deno.test("por Ata: previsto, gasto, cobrado e em falta na mesma linha de leitura", async () => {
  // As 4 perguntas do utilizador sobre a Ata 12 numa vista só.
  const html = await render("pages/reports/assemblies.vto", assembliesCtx());
  assertStringIncludes(html, "Ata 12");
  assertStringIncludes(html, "Despesa efetivada");
  assertStringIncludes(html, "86%");
  assertStringIncludes(html, "Quotas cobradas");
  assertStringIncludes(html, "53%");
  assertStringIncludes(html, "30 de 40 frações em dívida");
});

Deno.test("por Ata: despesas ambíguas são declaradas, não silenciadas", async () => {
  // Ambíguo = não contado. Se o total aparecesse sem aviso, o admin lia
  // "gastámos menos" quando na verdade faltava etiquetar.
  const html = await render(
    "pages/reports/assemblies.vto",
    assembliesCtx({
      assemblies: [{
        ...assembliesCtx().assemblies[0],
        budgets: [budgetExec({ ambiguousCount: 2, ambiguousCents: 50000 })],
      }],
    }),
  );
  assertStringIncludes(html, "500,00 €");
  assertStringIncludes(html, "não estão contadas");
});

Deno.test("por Ata: sem Ata ligada a orçamento, explica-se como ligar", async () => {
  // Empty state que ensina o passo em falta (ponto da ordem do dia com
  // ref_type=budget) em vez de deixar o ecrã vazio.
  const html = await render("pages/reports/assemblies.vto", assembliesCtx({ assemblies: [] }));
  assertStringIncludes(html, "ponto da ordem do dia ligado a um orçamento");
});

Deno.test("por Ata (detalhe): cada despesa diz se foi etiquetada ou inferida", async () => {
  // A confiança do número depende disto: inferido pode estar errado, e o
  // admin precisa de saber onde olhar.
  const html = await render("pages/reports/assembly_show.vto", {
    currentCondominiumId: "c1",
    adminNav: testAdminNav,
    title: "Ata 12",
    section: "report_assemblies",
    assembly: {
      ...assembliesCtx().assemblies[0],
      budgets: [budgetExec({
        lines: [{
          accountId: "acc1",
          accountCode: "6221",
          accountName: "Trabalhos especializados",
          budgetedCents: 3000000,
          actualCents: 2580000,
          varianceCents: 420000,
          chargeCount: 2,
          ambiguous: false,
        }],
        expenses: [{
          id: "ch1",
          code: "D0020",
          description: "Obrafix 1ª fatura obra",
          invoiceNumber: "FT 2026/001",
          accountCode: "6221",
          accountName: "Trabalhos especializados",
          supplierName: "Obrafix",
          competencePeriod: "2026-07-01",
          dueDate: "2026-07-15",
          status: "paid",
          originalAmountCents: 1200000,
          settledAmountCents: 1200000,
          openAmountCents: 0,
          source: "inferred",
        }],
        quotas: {
          ...budgetExec().quotas,
          byUnit: [{
            unitId: "u1",
            designation: "A",
            chargeCount: 3,
            issuedCents: 75000,
            settledCents: 0,
            openCents: 75000,
          }],
        },
      })],
    },
  });
  assertStringIncludes(html, "Inferida");
  assertStringIncludes(html, "D0020");
  // Fração em dívida sinalizada por estado, não só pelo número.
  assertStringIncludes(html, "Por pagar");
  assert(html.includes("750,00"), "valor em falta da fração visível");
});
