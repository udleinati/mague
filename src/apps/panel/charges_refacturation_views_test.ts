// Smoke tests de render da refaturação na página da despesa. Sem BD/API -
// render puro com dados mock (mesmo harness de charges_type_filter_test).
//
// Cobre o que o utilizador tem de ver e conseguir fazer no ecrã: um
// vencimento obrigatório e já preenchido, e uma listagem em que o código da
// cobrança abre a cobrança e a fração abre a fração.

import { assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";

const charge = (over: Record<string, unknown> = {}) => ({
  id: "ch_src",
  code: "D000A",
  kind: "payable",
  nature: "debit",
  chargeType: "supplier_service",
  status: "paid",
  description: "Elevadores - 01/2026",
  issueDate: "2026-01-10",
  dueDate: "2026-01-31",
  competencePeriod: "2026-01",
  originalAmount: 50000,
  settledAmount: 50000,
  openAmount: 0,
  note: null,
  invoiceNumber: null,
  documentNumber: null,
  paymentMethod: "manual",
  budgetId: null,
  unit: null,
  supplier: null,
  account: null,
  ...over,
});

const refacturation = (over: Record<string, unknown> = {}) => ({
  id: "ch_ref",
  code: "R000MO",
  unitId: "u1",
  unit_label: "A - Bloco 3 - Loja 1",
  issueDate: "2026-08-21",
  dueDate: "2026-09-30",
  originalAmount: 10000,
  settledAmount: 0,
  status: "open",
  ...over,
});

const showCtx = (over: Record<string, unknown> = {}) => ({
  currentCondominiumId: "c1",
  condominium: { reconciledThroughDate: null },
  title: "Cobrança",
  charge: charge(),
  sourceCharge: null,
  refacturations: [refacturation()],
  refacturedTotal: 10000,
  refacturable: 40000,
  canRefacture: true,
  units: [{ id: "u1", designation: "A", identifier: "Bloco 3 - Loja 1", permillage: 100 }],
  supplierLabel: null,
  unitLabel: null,
  accountLabel: null,
  ledgerEntries: [],
  ledgerTotals: { debit: 0, credit: 0 },
  fcrAmountCents: 0,
  attachments: [],
  budgets: [],
  refacturationDueDate: "2026-09-30",
  flash: null,
  ...over,
});

Deno.test("refaturação: vencimento é obrigatório e já vem preenchido", async () => {
  // Uma refaturação sem vencimento nunca conta como dívida em atraso (nem no
  // painel nem nos lembretes). Deixar o campo opcional era criar dívida
  // invisível; deixá-lo vazio era garantir que ninguém o preenchia.
  const html = await render("pages/charges/show.vto", showCtx());
  assertStringIncludes(html, 'name="dueDate"');
  assertStringIncludes(html, "required");
  assertStringIncludes(html, 'value="2026-09-30"');
  assertStringIncludes(html, "Vencimento");
});

Deno.test("refaturação: o formulário explica porque o vencimento importa", async () => {
  const html = await render("pages/charges/show.vto", showCtx());
  assertStringIncludes(html, "não entra nos atrasos");
});

Deno.test("refaturação: a listagem abre a cobrança pelo código", async () => {
  // O código é a referência humana da cobrança (CONTEXT.md "Charge code"); sem
  // coluna própria não havia forma de o ler nem de saltar para lá.
  const html = await render("pages/charges/show.vto", showCtx());
  assertStringIncludes(html, "R000MO");
  assertStringIncludes(html, '/admin/c/c1/charges/ch_ref"');
});

Deno.test("refaturação: a fração mostra o identificador e liga à fração", async () => {
  // ADR 0015: a designação de fração é sempre link para a fração. E "A"
  // sozinho não chega para distinguir - o identificador é que localiza.
  const html = await render("pages/charges/show.vto", showCtx());
  assertStringIncludes(html, "A - Bloco 3 - Loja 1");
  assertStringIncludes(html, '/admin/c/c1/units/u1"');
});

Deno.test("refaturação: sem refaturações, diz-se em vez de mostrar tabela vazia", async () => {
  const html = await render(
    "pages/charges/show.vto",
    showCtx({ refacturations: [], refacturedTotal: 0, refacturable: 50000 }),
  );
  assertStringIncludes(html, "Ainda não há refaturações para esta despesa");
});
