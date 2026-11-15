// Smoke tests de render do filtro de tipo ("A Receber"): separar quotas
// ordinárias das extraordinárias é uma leitura que o gestor faz a sério
// (orçamento anual vs obra). Sem BD/API - render puro, como charges_search_test.

import { assert, assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";

const baseData = (
  overrides: { kind?: string; nature?: string; filterChargeType?: string } = {},
) => ({
  currentCondominiumId: "c1",
  condominium: { reconciledThroughDate: null },
  title: "Quotas / A Receber",
  charges: [],
  monthGroups: [],
  kind: overrides.kind ?? "receivable",
  nature: overrides.nature ?? "debit",
  scope: "",
  filterYear: null,
  filterStatus: "",
  filterSearch: "",
  filterChargeType: overrides.filterChargeType ?? "",
  availableYears: [],
  outOfYear: null,
  suppliers: [],
  accounts: [],
  today: "2026-06-20",
  pagination: null,
  flash: null,
});

Deno.test("charges: A Receber tem filtro de tipo com as três leituras + Todos", async () => {
  const html = await render("pages/charges/_list_fragment.vto", baseData());
  assertStringIncludes(html, 'name="chargeType"');
  assertStringIncludes(html, '<option value="quota"');
  assertStringIncludes(html, '<option value="extraordinary_quota"');
  // "Outras" existe como valor próprio: a API resolve-o por exclusão das
  // quotas, senão tipos novos (juros, penalizações) ficavam invisíveis.
  assertStringIncludes(html, '<option value="other"');
  // Filtro server-side no mesmo form dos outros - compõe com ano/estado/pesquisa.
  assertStringIncludes(html, 'hx-include="closest form"');
});

Deno.test("charges: tipo escolhido fica selecionado (sobrevive ao swap/refresh)", async () => {
  const html = await render(
    "pages/charges/_list_fragment.vto",
    baseData({ filterChargeType: "extraordinary_quota" }),
  );
  const select = html.slice(html.indexOf('name="chargeType"'));
  assertStringIncludes(select, '<option value="extraordinary_quota" selected>');
  assert(
    !select.slice(0, select.indexOf("</select>")).includes('<option value="" selected>'),
    "com tipo filtrado, 'Todos' não pode ficar selecionado",
  );
});

Deno.test("charges: filtro de tipo só aparece em A Receber (não em despesas)", async () => {
  // Em "A Pagar" os tipos são supplier_service/expense - um filtro de quotas
  // ali só oferecia opções que nunca dão resultados.
  const html = await render(
    "pages/charges/_list_fragment.vto",
    baseData({ kind: "payable", nature: "" }),
  );
  assert(!html.includes('name="chargeType"'), "payable não deve ter filtro de tipo");
});

Deno.test("charges: com tipo filtrado aparece o 'Limpar filtros adicionais'", async () => {
  const html = await render(
    "pages/charges/_list_fragment.vto",
    baseData({ filterChargeType: "quota" }),
  );
  assertStringIncludes(html, "Limpar filtros adicionais");
});
