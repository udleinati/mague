// Smoke tests de render do cancelamento na página da cobrança. Sem BD/API -
// render puro com dados mock (mesmo harness de charges_refacturation_views_test).
//
// Cobre o que o admin tem de ver antes de cancelar: o que vai ser desfeito,
// uma justificação obrigatória e a palavra CANCELAR. E, depois, o motivo.

import { assert, assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";
import { buildAdminNav } from "./nav.ts";

const charge = (over: Record<string, unknown> = {}) => ({
  id: "ch_975",
  code: "R0001A",
  kind: "receivable",
  nature: "debit",
  chargeType: "opening_balance_debit",
  status: "paid",
  description: "Dívida de quotas 2025",
  issueDate: "2026-11-01",
  dueDate: null,
  competencePeriod: "2026-11",
  originalAmount: 97500,
  settledAmount: 97500,
  openAmount: 0,
  note: null,
  cancellationReason: null,
  invoiceNumber: null,
  documentNumber: null,
  paymentMethod: "manual",
  budgetId: null,
  unit: null,
  supplier: null,
  account: null,
  ...over,
});

const showCtx = (over: Record<string, unknown> = {}) => ({
  currentCondominiumId: "c1",
  // Fora de um pedido não há cid no ALS e o render injeta adminNav = null.
  adminNav: buildAdminNav({
    cid: "c1",
    activeSection: null,
    inspectionAlertCount: 0,
    availableCondominiums: [],
    occupantUnits: [],
  }),
  currentUser: { email: "admin@exemplo.pt" },
  condominium: { reconciledThroughDate: null },
  title: "Cobrança",
  charge: charge(),
  sourceCharge: null,
  refacturations: [],
  refacturedTotal: 0,
  refacturable: 0,
  canRefacture: false,
  canCancel: true,
  offsetsToUndo: [{
    id: "st1",
    amount: 97500,
    code: "R0000Z",
    description: "Crédito de adiantamento",
    competencePeriod: "2026-10-01",
  }],
  units: [],
  supplierLabel: null,
  unitLabel: null,
  accountLabel: null,
  ledgerEntries: [],
  ledgerTotals: { debit: 0, credit: 0 },
  fcrAmountCents: 0,
  attachments: [],
  budgets: [],
  refacturationDueDate: "2026-12-31",
  flash: null,
  ...over,
});

Deno.test("cancelar: modal mostra os offsets a desfazer e exige justificação + CANCELAR", async () => {
  // Uma cobrança saldada por offset com um crédito parece "paga"; cancelá-la devolve o
  // crédito à fração. O admin tem de ver isso antes de confirmar, e a ação fica
  // justificada (vai para a charge) e protegida contra o clique acidental.
  const html = await render("pages/charges/show.vto", showCtx());
  assertStringIncludes(html, 'id="cancel_charge_modal"');
  assertStringIncludes(html, "R0000Z");
  assertStringIncludes(html, "Compensações a desfazer (1)");
  assertStringIncludes(html, 'name="reason" required minlength="10"');
  assertStringIncludes(html, 'pattern="CANCELAR"');
  assertStringIncludes(html, 'action="/admin/c/c1/charges/ch_975/cancel"');
  // O botão da Zona perigosa abre o modal próprio; o modal global (sem campo de
  // justificação) não pode intercetar este form.
  assertStringIncludes(html, "document.getElementById('cancel_charge_modal').showModal()");
  assert(!html.includes('data-confirm-typed-match="CANCELAR"'));
});

Deno.test("cancelar: crédito diz crédito, não cobrança", async () => {
  const html = await render(
    "pages/charges/show.vto",
    showCtx({ charge: charge({ nature: "credit", chargeType: "credit_adjustment" }) }),
  );
  assertStringIncludes(html, "Cancelar crédito");
});

Deno.test("cancelar: sem canCancel (pagamento conciliado) não há zona perigosa", async () => {
  // Um pagamento conciliado com o banco reverte-se na conciliação; oferecer o
  // cancelamento aqui acabava num 409.
  const html = await render("pages/charges/show.vto", showCtx({ canCancel: false }));
  assert(!html.includes("cancel_charge_modal"));
  assert(!html.includes("data-danger-zone"));
});

Deno.test("cancelada: mostra o motivo do cancelamento", async () => {
  const html = await render(
    "pages/charges/show.vto",
    showCtx({
      canCancel: false,
      offsetsToUndo: [],
      charge: charge({ status: "cancelled", cancellationReason: "Lançada por engano na fração" }),
    }),
  );
  assertStringIncludes(html, "Motivo do cancelamento");
  assertStringIncludes(html, "Lançada por engano na fração");
});
