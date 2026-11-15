// Render do template da FOLHA DE PRESENÇAS (assembly_attendance_sheet.vto).
// Verifica a INTENÇÃO (Rule 9): fração mostra designação + identificação do bloco
// lado a lado e alinhada, sem etiqueta de convocatória, com a nota legal de quórum.
// Puro: `renderTemplate`, sem DB/Chromium. Datas via `formatDateTime`/`formatDate`.

import { assert, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { renderTemplate } from "$api/libs/templates/render.ts";

const CONDO = { name: "Condomínio Alfa", fiscalNumber: "501234567", address: "Rua A, 1, Lisboa" };

function render(overrides: Record<string, unknown> = {}) {
  return renderTemplate("assembly_attendance_sheet.vto", {
    condominium: CONDO,
    assembly: {
      type: "ordinary",
      scheduledAt: "2026-07-10T19:00:00+00:00",
      secondConvocationAt: "2026-07-10T19:30:00+00:00",
      location: "Sala do condomínio",
    },
    round: "first",
    fractions: [
      {
        designation: "A",
        identifier: "Bloco 1 - 1.º Dto",
        permillageLabel: "600,00",
        ownerNames: ["Alice Dona"],
      },
      {
        designation: "B",
        identifier: "Bloco 2 - 2.º Esq",
        permillageLabel: "400,00",
        ownerNames: [],
      },
    ],
    totals: { count: 2, permillageLabel: "1.000,00", requiredFirstRoundLabel: "500,00" },
    generatedAt: "2026-07-12T10:30:00+00:00",
    ...overrides,
  });
}

describe("template assembly_attendance_sheet.vto (folha de presenças)", () => {
  it("fração: designação (em slot alinhado) + identificação do bloco, designação primeiro", async () => {
    const html = await render();
    // WHY: os condóminos reconhecem a fração pela identificação (Bloco/Piso), não
    // pela letra; ambas aparecem, com a designação num slot de 1em por carácter
    // (1 letra -> 1em, 2 -> 2em, ...) para as identificações ficarem alinhadas.
    const iDesig = html.indexOf('min-width: 1em">A<');
    const iId = html.indexOf("Bloco 1 - 1.º Dto");
    assert(iDesig >= 0, "designação 'A' renderiza no slot de 1em");
    assert(iId >= 0, "identificação do bloco presente");
    assert(iDesig < iId, "designação renderiza antes da identificação na mesma célula");
  });

  it("sem etiqueta de convocatória em lado nenhum da folha", async () => {
    const first = await render({ round: "first" });
    const second = await render({ round: "second" });
    // WHY: a folha de presenças não precisa de dizer 1.ª/2.ª convocatória
    // (nem no cabeçalho nem na nota de quórum).
    assert(!first.includes("convocatória"), "1.ª convocatória não aparece");
    assert(!second.includes("convocatória"), "2.ª convocatória não aparece");
  });

  it("nota de quórum (Art. 1432.º) mantém-se, com o limiar de cada ronda", async () => {
    const first = await render({ round: "first" });
    const second = await render({ round: "second" });
    // 1.ª ronda: maioria estrita acima de metade da permilagem.
    assertStringIncludes(first, "maioria estrita");
    assertStringIncludes(first, "Art. 1432.º");
    // 2.ª ronda: qualquer permilagem > 0.
    assertStringIncludes(second, "qualquer permilagem");
    assertStringIncludes(second, "Art. 1432.º");
  });

  it("linha em branco quando a fração não tem proprietário registado", async () => {
    const html = await render();
    assertStringIncludes(html, "(sem proprietário registado)");
  });

  it("totais + rodapé de geração, sem travessões em-dash (convenção do projeto)", async () => {
    const html = await render();
    assertStringIncludes(html, "Documento gerado em 12/07/2026");
    assert(!html.includes("—"), "template não deve conter em-dash");
  });
});
