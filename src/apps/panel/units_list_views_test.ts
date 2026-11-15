// Coluna "Nota" na listagem de frações: o admin vê que há nota sem entrar na
// fração (ícone com tooltip, modal ao clicar) e encontra a fração pesquisando
// pelo texto - sem a coluna alargar a tabela ao ponto de partir os valores.

import { assert, assertStringIncludes } from "@std/assert";
import { render } from "./render.ts";

const unit = (over: Record<string, unknown>) => ({
  id: "u1",
  designation: "A",
  identifier: null,
  unitType: "residential",
  permillage: "500",
  block: null,
  floor: null,
  door: null,
  description: null,
  occupants: [],
  overdueDebtCents: 0,
  futureDebtCents: 0,
  isActive: true,
  hasActivePlan: false,
  ...over,
});

const renderList = (units: Record<string, unknown>[]) =>
  render("pages/units/list.vto", {
    currentCondominiumId: "c1",
    units,
    stats: {
      total: units.length,
      occupantsTotal: 0,
      unitsOverdue: 0,
      totalOverdueCents: 0,
      totalFutureDebtCents: 0,
    },
    totalPm: 1000,
    remaining: 0,
  });

// Linha `<tr>` da fração, para as asserções não apanharem o modal nem outra linha.
const rowOf = (html: string, designation: string) => {
  const rows = html.split("<tr")
    .map((r) => r.split("</tr>")[0])
    .filter((r) => r.includes(`>${designation}</span>`));
  assert(rows.length === 1, `esperava 1 linha para a fração ${designation}`);
  return rows[0];
};

const NOTE = "Prefere contacto por email, ao fim de semana";

Deno.test("units/list: nota vira ícone compacto (tooltip + modal), não texto na célula", async () => {
  const html = await renderList([unit({ designation: "A", description: NOTE })]);
  const row = rowOf(html, "A");
  assertStringIncludes(row, "openUnitNote(this)");
  assertStringIncludes(row, `data-tip="${NOTE}"`);
  // O texto só existe no tooltip e no span escondido: nenhum texto visível da
  // nota ocupa largura na coluna.
  assert(
    row.split(NOTE).length - 1 === 2,
    "a nota aparece só no data-tip e no span da pesquisa",
  );
  assertStringIncludes(html, 'id="unit_note_modal"');
});

Deno.test("units/list: o texto completo da nota continua pesquisável", async () => {
  const html = await renderList([unit({ designation: "A", description: NOTE })]);
  const row = rowOf(html, "A");
  // A pesquisa da tabela só lê `[data-search]`: sem isto, procurar "fim de
  // semana" deixava de encontrar a fração.
  assertStringIncludes(
    row,
    `<span class="hidden" data-search data-unit-note-full>${NOTE}</span>`,
  );
});

Deno.test("units/list: fração sem nota não tem ícone nem texto pesquisável de nota", async () => {
  const html = await renderList([unit({ designation: "C", description: null })]);
  const row = rowOf(html, "C");
  assert(!row.includes("data-unit-note-full"), "sem nota, nada a pesquisar");
  assert(!row.includes("openUnitNote"), "sem nota, nada a abrir");
});

Deno.test("units/list: nota com HTML é escapada (texto livre do admin)", async () => {
  const html = await renderList([
    unit({ designation: "D", description: '<img src=x onerror="alert(1)"> chave na portaria' }),
  ]);
  assert(!html.includes("<img src=x"), "a nota não pode injetar HTML na listagem");
  assertStringIncludes(html, "&lt;img src=x");
});

Deno.test("units/list: valores em euro não partem de linha", async () => {
  // Regressão: com a coluna da nota larga, "1.234,56 €" partia o "€" para
  // a linha de baixo. As duas células de valor ficam nowrap.
  const html = await renderList([
    unit({ designation: "E", overdueDebtCents: 123_456, futureDebtCents: 65_432 }),
  ]);
  const row = rowOf(html, "E");
  const moneyCells = row.split("<td").filter((c) => c.includes("€"));
  assert(moneyCells.length === 2, "esperava as células 'Em atraso' e 'Futuras'");
  for (const cell of moneyCells) assertStringIncludes(cell, "whitespace-nowrap");
});
