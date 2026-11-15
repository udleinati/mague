// Render dos templates de convocatória + procuração. Verifica a INTENÇÃO do
// conteúdo (Rule 9), não markup: datas, ordem do dia, e a redação da procuração
// por natureza jurídica (singular vs coletiva). Puro: `renderTemplate`, sem DB/Chromium.

import { assert, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { renderTemplate } from "$api/libs/templates/render.ts";

const CONDO = { name: "Condomínio Alfa", fiscalNumber: "501234567", address: "Rua A, 1" };
const ASSEMBLY = {
  type: "ordinary",
  scheduledAt: "2026-07-10T19:00:00+00:00",
  secondConvocationAt: "2026-07-10T19:30:00+00:00",
  location: "Sala do condomínio",
  convocationIntro: "Caros condóminos, eis a convocatória anual.",
  convocationFooter: "Documentos disponíveis no portal.",
};
const AGENDA_ITEMS = [
  { sequence: 1, subject: "Aprovação do orçamento 2026", description: "Discussão e votação." },
  { sequence: 2, subject: "Outros assuntos" },
];

describe("template assembly_convocation.vto", () => {
  it("reflete datas (1ª/2ª com hora), local, ordem do dia, intro/footer, NIF", async () => {
    const html = await renderTemplate("assembly_convocation.vto", {
      condominium: CONDO,
      assembly: ASSEMBLY,
      agendaItems: AGENDA_ITEMS,
      generatedAt: "2026-06-04T10:00:00+00:00",
    });
    assertStringIncludes(html, "Convocatória de Assembleia Ordinária");
    // 1ª e 2ª convocações com data E hora (formatDateTime, UTC).
    assertStringIncludes(html, "10/07/2026 19:00");
    assertStringIncludes(html, "10/07/2026 19:30");
    assertStringIncludes(html, "Sala do condomínio");
    assertStringIncludes(html, "Ordem do dia");
    assertStringIncludes(html, "Aprovação do orçamento 2026");
    assertStringIncludes(html, "Outros assuntos");
    assertStringIncludes(html, "Caros condóminos, eis a convocatória anual.");
    assertStringIncludes(html, "Documentos disponíveis no portal.");
    assertStringIncludes(html, "NIF 501234567");
    // Sem travessões em-dash (convenção do projeto).
    assert(!html.includes("—"), "template não deve conter em-dash");
  });

  it("ordem do dia vazia mostra 'por definir' (não rebenta)", async () => {
    const html = await renderTemplate("assembly_convocation.vto", {
      condominium: CONDO,
      assembly: { ...ASSEMBLY, convocationIntro: null, convocationFooter: null },
      agendaItems: [],
      generatedAt: "2026-06-04T10:00:00+00:00",
    });
    assertStringIncludes(html, "Ordem do dia por definir.");
  });
});

describe("template assembly_proxy.vto (procuração)", () => {
  it("preview: pessoa singular por defeito, placeholders em nome/NIF/fração", async () => {
    // Reflete o que a rota proxy.pdf envia: nome/fração a null (placeholders via
    // `??`) e o NIF como placeholder explícito (o preview é um modelo genérico).
    const html = await renderTemplate("assembly_proxy.vto", {
      condominium: CONDO,
      assembly: ASSEMBLY,
      recipient: {
        name: null,
        nif: "[NIF do condómino]",
        personType: null,
        unitLabel: null,
      },
      generatedAt: "2026-06-04T10:00:00+00:00",
    });
    assertStringIncludes(html, "Procuração");
    assertStringIncludes(html, "[Nome do condómino]");
    assertStringIncludes(html, "[Fração]");
    // Sem natureza definida -> redação singular ("Eu, ..." + "relativo à fração").
    assertStringIncludes(html, "Eu,");
    assertStringIncludes(html, "relativo à fração");
    // WHY: no preview o NIF mostra um placeholder (como o nome/fração), não uma
    // linha em branco - a linha em branco só aparece num envio real sem NIF.
    assertStringIncludes(html, "NIF");
    assertStringIncludes(html, "[NIF do condómino]");
    assertStringIncludes(html, "10/07/2026 19:00");
    assertStringIncludes(html, "Art. 1431.º");
    assert(!html.includes("—"), "template não deve conter em-dash");
  });

  it("singular personalizada: 'Eu, ...' + NIF + unitLabel, sem placeholders", async () => {
    const html = await renderTemplate("assembly_proxy.vto", {
      condominium: CONDO,
      assembly: ASSEMBLY,
      recipient: {
        name: "Maria Silva",
        nif: "123456789",
        personType: "singular",
        unitLabel: "AT - Bloco 3 5C",
      },
      generatedAt: "2026-06-04T10:00:00+00:00",
    });
    assertStringIncludes(html, "Eu,");
    assertStringIncludes(html, "Maria Silva");
    // WHY: a fração entra já formatada via unitLabel ("designation - identifier").
    assertStringIncludes(html, "AT - Bloco 3 5C");
    // WHY: o NIF impresso desambigua nomes longos/abreviados (ex. "Ana R").
    assertStringIncludes(html, "123456789");
    assert(!html.includes("[Nome do condómino]"), "não deve restar placeholder de nome");
    assert(!html.includes("[Fração]"), "não deve restar placeholder de fração");
  });

  it("coletiva: redação da empresa + NIPC ('declara nomear como sua representante')", async () => {
    const html = await renderTemplate("assembly_proxy.vto", {
      condominium: CONDO,
      assembly: ASSEMBLY,
      recipient: {
        name: "Imobiliária X, Lda",
        nif: "501234567",
        personType: "collective",
        unitLabel: "AT - Bloco 3 5C",
      },
      generatedAt: "2026-06-04T10:00:00+00:00",
    });
    // WHY: a procuração de uma empresa não pode sair com redação de pessoa
    // singular ("Eu, [Empresa]"); usa a redação da pessoa coletiva e o rótulo
    // fiscal NIPC. (O nome vem dentro de <span class="fill">, daí asserir só o
    // nome e os marcadores exclusivos do ramo coletivo.)
    assertStringIncludes(html, "Imobiliária X, Lda");
    assertStringIncludes(html, "NIPC");
    assertStringIncludes(html, "501234567");
    assertStringIncludes(html, "na qualidade de proprietária da fração");
    assertStringIncludes(html, "declara nomear como sua representante");
    assertStringIncludes(html, "AT - Bloco 3 5C");
    // Discrimina o ramo: a redação singular ("Eu, ..." / "declaro ... meu") não
    // pode aparecer para uma pessoa coletiva.
    assert(
      !html.includes("declaro nomear como meu representante"),
      "não deve usar redação singular",
    );
    assert(!html.includes("[Fração]"), "não deve restar placeholder de fração");
    assert(!html.includes("—"), "template não deve conter em-dash");
  });

  it("singular sem NIF no registo: nome impresso, linha em branco para o NIF", async () => {
    const html = await renderTemplate("assembly_proxy.vto", {
      condominium: CONDO,
      assembly: ASSEMBLY,
      recipient: { name: "Ana R", nif: null, personType: "singular", unitLabel: "1.º Dto" },
      generatedAt: "2026-06-04T10:00:00+00:00",
    });
    assertStringIncludes(html, "Ana R");
    // NIF nullable -> mesmo no envio real fica espaço a preencher à mão.
    assertStringIncludes(html, 'class="nif-blank"');
  });

  it("modo em branco (residente): identificação TODA em branco, sem nome/fração", async () => {
    // WHY: a procuração do residente sai por preencher por um PROPRIETÁRIO - o
    // residente não vota, logo o nome dele NÃO pode aparecer como mandante
    // (seria juridicamente inválida). Tudo são linhas em branco (ADR 0034).
    const html = await renderTemplate("assembly_proxy.vto", {
      condominium: CONDO,
      assembly: ASSEMBLY,
      recipient: { mode: "blank", name: "Maria Reside", unitLabel: "AT - 5C" },
      generatedAt: "2026-06-04T10:00:00+00:00",
    });
    // Redação genérica "Eu, ..." mas o nome/fração não saem impressos.
    assertStringIncludes(html, "Eu,");
    assert(!html.includes("Maria Reside"), "o nome do residente não pode sair na procuração");
    assert(!html.includes("AT - 5C"), "a fração não é pré-preenchida no modo em branco");
    // Linhas em branco para nome, NIF e fração.
    assertStringIncludes(html, 'class="nif-blank"');
    assertStringIncludes(html, 'class="blank short"');
    assertStringIncludes(html, "10/07/2026 19:00");
    assert(!html.includes("—"), "template não deve conter em-dash");
  });
});
