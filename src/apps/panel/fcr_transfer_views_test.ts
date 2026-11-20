// Smoke tests de render da transferência entre bolsas na listagem de contas
// bancárias. Sem BD/API - render puro com dados mock (mesmo harness do
// insurance_views_test).

import { assert, assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";
import { testAdminNav } from "./_admin_nav_fixture.ts";

const baseStats = {
  total: 0,
  active: 0,
  totalPending: 0,
  totalBalance: 0,
  ordinaryCents: 30000,
  fcrCents: 10000,
  ledgerCents: 40000,
  unreconciledCents: 0,
};

const listCtx = (over: Record<string, unknown> = {}) => ({
  currentCondominiumId: "c1",
  adminNav: testAdminNav,
  accounts: [],
  fcrTransfers: [],
  stats: baseStats,
  ...over,
});

const transfer = (over: Record<string, unknown> = {}) => ({
  id: "fcrt_1",
  direction: "to_fcr",
  amountCents: 5000,
  transferDate: "2026-03-01",
  reason: "Deliberação da assembleia de 2026-02-15",
  ...over,
});

Deno.test("bolsas: o modal mostra o saldo disponível de cada bolsa", async () => {
  // O admin decide o montante a olhar para estes números. Se o modal não os
  // mostrar, só descobre que não há saldo depois de submeter e levar 422.
  const html = await render("pages/bank_accounts/list.vto", listCtx());
  assertStringIncludes(html, "fcr_transfer_modal");
  assertStringIncludes(html, "Transferir entre bolsas");
  assertStringIncludes(html, 'name="direction" value="to_fcr"');
  assertStringIncludes(html, 'name="direction" value="to_ordinary"');
  assertStringIncludes(html, "/bank-accounts/fcr-transfer");
  // Saldos das duas bolsas visíveis no formulário (300,00 e 100,00).
  assertStringIncludes(html, "300,00");
  assertStringIncludes(html, "100,00");
});

Deno.test("bolsas: o modal avisa que não há anulação", async () => {
  // Decisão de desenho: a tabela é append-only. Se o admin não souber disto
  // antes de submeter, vai procurar um botão de apagar que não existe.
  const html = await render("pages/bank_accounts/list.vto", listCtx());
  assertStringIncludes(html, "sentido contrário");
  // E que o dinheiro não sai do banco - senão parece uma transferência real.
  assertStringIncludes(html, "Nenhum dinheiro sai do banco");
});

Deno.test("bolsas: motivo é obrigatório no formulário", async () => {
  // Espelha o NOT NULL da BD e o `min(1)` do Zod. Sem `required` o admin só
  // descobre a regra no erro do servidor.
  const html = await render("pages/bank_accounts/list.vto", listCtx());
  const reasonField = html.slice(html.indexOf('id="fcr_reason"'));
  assertStringIncludes(reasonField.slice(0, 400), "required");
});

Deno.test("bolsas: sem transferências não aparece tabela de histórico", async () => {
  // Condomínios que nunca transferiram não levam com uma tabela vazia.
  const html = await render("pages/bank_accounts/list.vto", listCtx());
  assert(!html.includes("Transferências entre bolsas"));
});

Deno.test("bolsas: histórico mostra sentido, valor e motivo de cada linha", async () => {
  // O motivo é o que torna a transferência auditável - se a listagem o
  // esconder, a coluna `reason` fica a servir de nada.
  const html = await render(
    "pages/bank_accounts/list.vto",
    listCtx({
      fcrTransfers: [
        transfer(),
        transfer({
          id: "fcrt_2",
          direction: "to_ordinary",
          amountCents: 2500,
          reason: "Correção da transferência fcrt_1",
        }),
      ],
    }),
  );
  assertStringIncludes(html, "Transferências entre bolsas");
  assertStringIncludes(html, "Deliberação da assembleia de 2026-02-15");
  assertStringIncludes(html, "Correção da transferência fcrt_1");
  assertStringIncludes(html, "50,00");
  assertStringIncludes(html, "25,00");
  // Sentido legível nas duas direções (não o valor cru do enum).
  assert(!html.includes(">to_fcr<"));
  assertStringIncludes(html, "Ordinária <span");
  assertStringIncludes(html, "FCR <span");
});
