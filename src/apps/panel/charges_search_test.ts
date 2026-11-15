// Smoke tests de render: a pesquisa de cobranças é server-side (ILIKE na API),
// não o filtro client-side que só via a página corrente. Sem BD/API - render
// puro com dados mock (mesmo harness do payment_plan_views_test).

import { assert, assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";

const baseData = (filterSearch: string) => ({
  currentCondominiumId: "c1",
  condominium: { reconciledThroughDate: null },
  title: "Quotas / A Receber",
  charges: [],
  monthGroups: [],
  kind: "receivable",
  nature: "debit",
  scope: "",
  filterYear: null,
  filterStatus: "",
  filterSearch,
  availableYears: [],
  outOfYear: null,
  suppliers: [],
  accounts: [],
  today: "2026-06-20",
  pagination: null,
  flash: null,
});

Deno.test("charges: pesquisa é server-side (input no form de filtros, dispara hx-get)", async () => {
  const html = await render("pages/charges/_list_fragment.vto", baseData(""));
  // O input de pesquisa vive no form de filtros e bate na rota /charges via
  // HTMX - é o que empurra o ILIKE para a API em vez de filtrar no browser.
  assertStringIncludes(html, 'name="search"');
  assertStringIncludes(html, 'hx-get="/admin/c/c1/charges"');
  assertStringIncludes(html, 'hx-include="closest form"');
  // O nó é preservado entre swaps (senão perdia foco a cada tecla).
  assertStringIncludes(html, 'hx-preserve="true"');
  // Sem filtro client-side (só veria a página corrente).
  assert(!html.includes("data-table-search"), "data-table-search não deve existir");
});

Deno.test("charges: sem pesquisa → grupos ficam no estado normal (sem auto-expand)", async () => {
  const html = await render("pages/charges/_list_fragment.vto", baseData(""));
  assert(!html.includes("data-search-active"), "sem search não há marca de scope");
});

Deno.test("charges: com pesquisa → input pré-preenchido + grupos auto-expandidos", async () => {
  const html = await render("pages/charges/_list_fragment.vto", baseData("R00042"));
  // Valor preservado na URL/refresh.
  assertStringIncludes(html, 'value="R00042"');
  // A API já devolveu só os matches; o scope marca-se e o script expande os
  // grupos no load, senão os matches ficavam escondidos em grupos fechados.
  assertStringIncludes(html, "data-search-active");
  assertStringIncludes(html, "[data-month-scope][data-search-active]");
});
