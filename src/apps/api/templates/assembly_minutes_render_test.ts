// Render do template da ATA (assembly_minutes.vto). Verifica a INTENÇÃO do
// conteúdo (Rule 9), não markup: cabeçalho, presenças (presente vs procuração),
// deliberações (resultado derivado, ponto informativo, por votar), assinaturas
// e estados vazios. Puro: `renderTemplate`, sem DB/Chromium. Datas via `formatDate` (UTC).

import { assert, assertStringIncludes } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { renderTemplate } from "$api/libs/templates/render.ts";

const CONDO = { name: "Condomínio Alfa", fiscalNumber: "501234567", address: "Rua A, 1, Lisboa" };

describe("template assembly_minutes.vto (ata) - ata completa", () => {
  // Ata "rica": 1ª convocatória, com número, 2 presenças (1 presente + 1 por
  // procuração), 2 deliberações (1 aprovada + 1 rejeitada), signatários e
  // textos de abertura/encerramento, já assinada.
  async function render() {
    return await renderTemplate("assembly_minutes.vto", {
      condominium: CONDO,
      assembly: {
        title: "Assembleia Geral Ordinária 2026",
        type: "ordinary",
        minutesNumber: "42",
        convocationRound: "first",
        scheduledAt: "2026-07-10T19:00:00+00:00",
        secondConvocationAt: "2026-07-10T19:30:00+00:00",
        location: "Sala do condomínio",
        introduction: "Aos dez dias de julho reuniu a assembleia.",
        conclusion: "Nada mais havendo a tratar, encerrou-se a sessão.",
        minutesSignedAt: "2026-07-12T10:00:00+00:00",
      },
      decisions: [
        {
          sequence: 1,
          subject: "Aprovação do orçamento 2026",
          description: "Discussão e votação do orçamento anual.",
          itemType: "approve_budget",
          votesInFavor: "600.000",
          votesAgainst: "0.000",
          votesAbstain: "0.000",
          approved: true,
        },
        {
          sequence: 2,
          subject: "Obras na fachada",
          itemType: "other",
          votesInFavor: "300.000",
          votesAgainst: "500.000",
          votesAbstain: "100.000",
          approved: false,
        },
      ],
      attendees: [
        {
          occupantName: "Alice Dona",
          unitDesignation: "A",
          unitIdentifier: "Bloco 1 - 1.º Dto",
          permillageAtMeeting: "600.000",
          proxyHolderName: null,
        },
        {
          occupantName: "Bruno Titular",
          unitDesignation: "B",
          unitIdentifier: "Bloco 2 - 2.º Esq",
          permillageAtMeeting: "400.000",
          proxyHolderName: "Sofia Mandatária",
        },
      ],
      // Presença = 600 + 400 = 1000‰ (presença total). Base das % de votação.
      presentPermillage: 1000,
      presidentName: "Carla Presidente",
      secretaryName: "David Secretário",
      generatedAt: "2026-07-12T10:30:00+00:00",
    });
  }

  it("cabeçalho: condomínio + NIF + morada", async () => {
    const html = await render();
    // Tipo da assembleia (ordinária/extraordinária) no título do documento.
    assertStringIncludes(html, "Ata da Assembleia Ordinária de Condóminos");
    assertStringIncludes(html, "Condomínio Alfa");
    assertStringIncludes(html, "NIF 501234567");
    assertStringIncludes(html, "Rua A, 1, Lisboa");
  });

  it("título: N.º da ata + o assunto na linha 'Assunto'", async () => {
    const html = await render();
    // Com minutesNumber, o h1 é "Ata N.º 42" e o título passa para "Assunto".
    assertStringIncludes(html, "Ata");
    assertStringIncludes(html, "42");
    assertStringIncludes(html, "Assunto");
    assertStringIncludes(html, "Assembleia Geral Ordinária 2026");
  });

  it("'Realizada em': data E HORA da 1ª convocação com a etiqueta correta", async () => {
    const html = await render();
    // round=first -> data+hora agendada + "(1.ª convocatória)" (formatDateTime UTC).
    assertStringIncludes(html, "10/07/2026 19:00");
    assertStringIncludes(html, "(1.ª convocatória)");
    assertStringIncludes(html, "Sala do condomínio");
  });

  it("signatários: nomes do presidente e secretário", async () => {
    const html = await render();
    assertStringIncludes(html, "Carla Presidente");
    assertStringIncludes(html, "David Secretário");
    // Já assinada -> mostra a data de assinatura (não "(por designar)").
    assertStringIncludes(html, "Assinada em 12/07/2026");
    assert(!html.includes("(por designar)"), "ata assinada não deve ter '(por designar)'");
  });

  it("textos livres: abertura e encerramento", async () => {
    const html = await render();
    assertStringIncludes(html, "Abertura");
    assertStringIncludes(html, "Aos dez dias de julho reuniu a assembleia.");
    assertStringIncludes(html, "Encerramento");
    assertStringIncludes(html, "Nada mais havendo a tratar, encerrou-se a sessão.");
  });

  it("presenças: fração (designação + identificação do bloco), condómino, permilagem + total", async () => {
    const html = await render();
    // A folha de presenças é agora o Anexo 1 (depois das assinaturas/rodapé), não
    // uma secção no corpo da ata.
    assertStringIncludes(html, "Anexo 1 - Folha de Presenças");
    assert(
      html.indexOf("Documento gerado em") < html.indexOf("Anexo 1 - Folha de Presenças"),
      "a folha de presenças é um anexo (vem depois do rodapé de geração)",
    );
    assertStringIncludes(html, "Alice Dona");
    // WHY: a fração mostra designação E identificação (Bloco/Piso) - ninguém
    // reconhece a fração só pela letra.
    assertStringIncludes(html, "A");
    assertStringIncludes(html, "Bloco 1 - 1.º Dto");
    assertStringIncludes(html, "600.00‰");
    assertStringIncludes(html, "Bruno Titular");
    assertStringIncludes(html, "Bloco 2 - 2.º Esq");
    assertStringIncludes(html, "400.00‰");
    // WHY: presença por procuração mostra o portador por baixo do titular, em
    // letra menor, para deixar claro que o titular não veio em causa própria.
    assertStringIncludes(html, "Representado por Sofia Mandatária");
    // Só a presença por procuração leva a nota; a presença própria (Alice) não.
    assert(
      html.split("Representado por").length - 1 === 1,
      "apenas a presença por procuração tem a nota 'Representado por'",
    );
    // Fração vem ANTES do condómino na tabela.
    assert(
      html.indexOf("Bloco 1 - 1.º Dto") < html.indexOf("Alice Dona"),
      "coluna Fração precede a coluna Condómino",
    );
    // Cabeçalho abreviado "Perm.", sem colunas "#"/"Modo".
    assertStringIncludes(html, "Perm.");
    assert(!html.includes("Permilagem"), "cabeçalho usa 'Perm.' abreviado");
    assert(!html.includes(">Modo<"), "coluna 'Modo' removida");
    // Total: 2 presenças + soma das permilagens (600 + 400 = 1000).
    assertStringIncludes(html, "Total (2 presenças)");
    assertStringIncludes(html, "1000.00‰");
  });

  it("ordem do dia: pontos numerados por extenso, resultado + contagem de votos", async () => {
    const html = await render();
    assertStringIncludes(html, "Ordem do dia");
    // Ponto 1: numerado por extenso ("Ponto um"), sem etiqueta de tipo, + resultado/votos.
    assertStringIncludes(html, "Ponto um");
    assertStringIncludes(html, "Aprovação do orçamento 2026");
    assertStringIncludes(html, "Aprovada");
    // WHY: o voto mostra a percentagem relativa à permilagem presente (presentes =
    // 100%) em destaque e a permilagem exata entre parênteses (valor legal da
    // maioria). Aqui presença = 1000‰, logo % presente == % edifício.
    assertStringIncludes(html, "A favor 60%");
    assertStringIncludes(html, "(600.000‰)");
    assertStringIncludes(html, "Contra 0%");
    assertStringIncludes(html, "Abstenções 0%");
    assertStringIncludes(html, "(0.000‰)");
    // Ponto 2: rejeitado (approved=false), com a contagem que o justifica.
    assertStringIncludes(html, "Ponto dois");
    assertStringIncludes(html, "Obras na fachada");
    assertStringIncludes(html, "Rejeitada");
    assertStringIncludes(html, "A favor 30%");
    assertStringIncludes(html, "(300.000‰)");
    assertStringIncludes(html, "Contra 50%");
    assertStringIncludes(html, "(500.000‰)");
    // WHY: a ata usa "Ordem do dia"/"Ponto N" e NÃO mostra o tipo do ponto:
    // sem "Deliberação" nem "Aprovar orçamento".
    assert(!html.includes("Deliberaç"), "secção usa 'Ponto', não 'Deliberação'");
    assert(!html.includes("Aprovar orçamento"), "tipo do ponto não aparece na ata");
  });

  it("rodapé de geração + sem travessões em-dash (convenção do projeto)", async () => {
    const html = await render();
    assertStringIncludes(html, "Documento gerado em 12/07/2026");
    assert(!html.includes("—"), "template não deve conter em-dash");
  });
});

describe("template assembly_minutes.vto (ata) - nota da votação", () => {
  const base = {
    condominium: CONDO,
    assembly: {
      title: "AG",
      type: "ordinary",
      minutesNumber: "11",
      convocationRound: "first",
      scheduledAt: "2026-07-10T19:00:00+00:00",
      location: "Sala",
    },
    attendees: [],
    // Presença total = 1000‰ (base das %); votos abaixo somam <= 1000.
    presentPermillage: 1000,
    presidentName: null,
    secretaryName: null,
    generatedAt: "2026-07-12T10:30:00+00:00",
  };

  it("nota presente: aparece junto ao resultado (dentro do bloco de votos)", async () => {
    const html = await renderTemplate("assembly_minutes.vto", {
      ...base,
      decisions: [{
        sequence: 1,
        subject: "Obras na fachada",
        itemType: "other",
        votesInFavor: "700.000",
        votesAgainst: "300.000",
        votesAbstain: "0.000",
        approved: true,
        voteNote: "Votação por braço no ar; aprovada por maioria de 70%.",
      }],
    });
    // WHY: a nota documenta COMO se votou e tem de surgir junto ao resultado -
    // depois dos pills, dentro do bloco `.votes`.
    assertStringIncludes(html, "Votação por braço no ar; aprovada por maioria de 70%.");
    assert(
      html.indexOf("A favor 70%") < html.indexOf("aprovada por maioria de 70%"),
      "a nota da votação vem depois do resultado/contagem",
    );
  });

  it("sem nota: não renderiza linha extra", async () => {
    const html = await renderTemplate("assembly_minutes.vto", {
      ...base,
      decisions: [{
        sequence: 1,
        subject: "Obras na fachada",
        itemType: "other",
        votesInFavor: "700.000",
        votesAgainst: "300.000",
        votesAbstain: "0.000",
        approved: true,
      }],
    });
    // `vote-note` aparece sempre no CSS; o que não pode existir é o elemento.
    assert(!html.includes('class="vote-note"'), "sem voteNote não há bloco de nota da votação");
  });
});

describe("template assembly_minutes.vto (ata) - percentagem relativa aos presentes", () => {
  // Base da % = permilagem PRESENTE (presentes = 100%), não os 1000‰ do edifício.
  // Estes casos têm presença < 1000‰: falhariam com a base antiga (‰ / 10).
  const base = {
    condominium: CONDO,
    assembly: {
      title: "AG",
      minutesNumber: "12",
      convocationRound: "first",
      scheduledAt: "2026-07-10T19:00:00+00:00",
      location: "Sala",
    },
    attendees: [],
    presidentName: null,
    secretaryName: null,
    generatedAt: "2026-07-12T10:30:00+00:00",
  };

  it("60% de presença, todos a favor: 100% (não 60%); ‰ legal entre parênteses", async () => {
    const html = await renderTemplate("assembly_minutes.vto", {
      ...base,
      presentPermillage: 600,
      decisions: [{
        sequence: 1,
        subject: "Obras na fachada",
        itemType: "other",
        votesInFavor: "600.000",
        votesAgainst: "0.000",
        votesAbstain: "0.000",
        approved: true,
      }],
    });
    // WHY: os presentes (600‰) são a base 100%, logo "todos a favor" = 100%,
    // não 60% (que seria a leitura sobre o edifício total).
    assertStringIncludes(html, "A favor 100%");
    // O valor legal da maioria (‰ do edifício) mantém-se entre parênteses.
    assertStringIncludes(html, "(600.000‰)");
    assert(!html.includes("A favor 60%"), "% é relativa aos presentes, não ao edifício");
  });

  it("50% de presença, voto dividido: % somam 100% entre os presentes", async () => {
    const html = await renderTemplate("assembly_minutes.vto", {
      ...base,
      presentPermillage: 500,
      decisions: [{
        sequence: 1,
        subject: "Obras na fachada",
        itemType: "other",
        votesInFavor: "300.000",
        votesAgainst: "200.000",
        votesAbstain: "0.000",
        approved: false,
      }],
    });
    // 300/500 = 60% e 200/500 = 40% (somam 100% entre os presentes), não 30%/20%.
    assertStringIncludes(html, "A favor 60%");
    assertStringIncludes(html, "Contra 40%");
    assertStringIncludes(html, "(300.000‰)");
    assertStringIncludes(html, "(200.000‰)");
  });
});

describe("template assembly_minutes.vto (ata) - estados vazios e fallbacks", () => {
  it("sem número (usa título), 2ª convocatória, sem presenças/deliberações/signatários", async () => {
    const html = await renderTemplate("assembly_minutes.vto", {
      condominium: { name: "Condomínio Beta", fiscalNumber: null, address: null },
      assembly: {
        title: "Assembleia Extraordinária",
        type: "extraordinary",
        minutesNumber: null,
        convocationRound: "second",
        scheduledAt: "2026-09-01T18:00:00+00:00",
        secondConvocationAt: "2026-09-01T18:30:00+00:00",
        location: null,
        introduction: null,
        conclusion: null,
        minutesSignedAt: null,
      },
      decisions: [],
      attendees: [],
      presidentName: null,
      secretaryName: null,
      generatedAt: "2026-09-02T09:00:00+00:00",
    });
    // Sem número -> o h1 é o próprio título da assembleia (sem "Assunto").
    assertStringIncludes(html, "Assembleia Extraordinária");
    assert(!html.includes("Ata <span"), "sem minutesNumber não há 'Ata N.º'");
    // Tipo extraordinário no título do documento.
    assertStringIncludes(html, "Ata da Assembleia Extraordinária de Condóminos");
    // round=second -> data E HORA da 2ª convocação + etiqueta.
    assertStringIncludes(html, "01/09/2026 18:30");
    assertStringIncludes(html, "(2.ª convocatória)");
    // Estados vazios não rebentam: avisos explícitos.
    assertStringIncludes(html, "Sem presenças registadas.");
    assertStringIncludes(html, "Sem pontos registados.");
    // Sem signatários definidos -> placeholder, e não há data de assinatura.
    assertStringIncludes(html, "(por designar)");
    assert(!html.includes("Assinada em"), "ata não assinada não mostra data de assinatura");
    assert(!html.includes("—"), "template não deve conter em-dash");
  });

  it("ponto informativo: pill 'sem votação', sem Aprovada/Rejeitada nem contagens", async () => {
    const html = await renderTemplate("assembly_minutes.vto", {
      condominium: CONDO,
      assembly: {
        title: "AG",
        minutesNumber: "7",
        convocationRound: "first",
        scheduledAt: "2026-07-10T19:00:00+00:00",
        location: "Sala",
      },
      decisions: [
        {
          sequence: 1,
          subject: "Ponto de situação das obras",
          itemType: "info",
          votesInFavor: "0.000",
          votesAgainst: "0.000",
          votesAbstain: "0.000",
          approved: null,
        },
      ],
      attendees: [],
      presidentName: null,
      secretaryName: null,
      generatedAt: "2026-07-12T10:30:00+00:00",
    });
    // WHY: um ponto informativo não é deliberado; o pill explícito reforça que
    // a ausência de votação é intencional, não uma omissão.
    assertStringIncludes(html, "Ponto informativo (sem votação)");
    assert(!html.includes("Aprovada"), "ponto info não tem resultado aprovado");
    assert(!html.includes("Rejeitada"), "ponto info não tem resultado rejeitado");
    assert(!html.includes("A favor"), "ponto info não mostra contagem de votos");
  });

  it("ponto por votar (approved=null, não-info): mostra contagens, sem resultado", async () => {
    const html = await renderTemplate("assembly_minutes.vto", {
      condominium: CONDO,
      assembly: {
        title: "AG",
        minutesNumber: "8",
        convocationRound: "first",
        scheduledAt: "2026-07-10T19:00:00+00:00",
        location: "Sala",
      },
      decisions: [
        {
          sequence: 1,
          subject: "Aprovação de contas",
          itemType: "accounts_approval",
          votesInFavor: "0.000",
          votesAgainst: "0.000",
          votesAbstain: "0.000",
          approved: null,
        },
      ],
      attendees: [],
      presidentName: null,
      secretaryName: null,
      generatedAt: "2026-07-12T10:30:00+00:00",
    });
    // WHY: um ponto deliberável ainda não votado (approved=null) mostra a
    // grelha de votos (a zeros) mas não pode anunciar Aprovada/Rejeitada.
    assertStringIncludes(html, "Aprovação de contas");
    assertStringIncludes(html, "A favor 0%");
    assertStringIncludes(html, "(0.000‰)");
    assert(!html.includes("Aprovada"), "ponto por votar não anuncia resultado");
    assert(!html.includes("Rejeitada"), "ponto por votar não anuncia resultado");
  });
});

describe("template assembly_minutes.vto (ata) - anexos do orçamento", () => {
  // Orçamento principal aprovado, com 1 rubrica e mapa de quotas (valores reais
  // cobrados). Shape = formatBudgetForResponse + formatBudgetQuotaMapForResponse.
  const ANNEX_BUDGET = {
    year: "2026",
    type: "principal",
    status: "approved",
    notes: "Proposta A",
    fcrPercentage: "10.00",
    fcrAmount: 12000,
    totalAmount: 120000,
    approvedAt: "2026-07-10T00:00:00+00:00",
    installments: null,
    lines: [{
      categoryCode: "MAN",
      categoryName: "Manutenção elevador",
      categoryDescription: null,
      annualAmount: 120000,
    }],
  };
  const ANNEX_QUOTA = {
    units: [
      {
        unitDesignation: "1.º Dto",
        identifier: "A",
        unitPermillage: "600.000",
        monthlyBaseCents: 6000,
        monthlyFcrCents: 600,
        monthlyTotalCents: 6600,
        annualTotalCents: 79200,
      },
      {
        unitDesignation: "2.º Esq",
        identifier: "B",
        unitPermillage: "400.000",
        monthlyBaseCents: 4000,
        monthlyFcrCents: 400,
        monthlyTotalCents: 4400,
        annualTotalCents: 52800,
      },
    ],
    totalPermillage: "1000.000",
    totals: {
      monthlyBaseCents: 10000,
      monthlyFcrCents: 1000,
      monthlyTotalCents: 11000,
      annualTotalCents: 132000,
    },
    fromCharges: true,
  };
  // Orçamento suplementar em 3 prestações (sem FCR), valores em previsão.
  const ANNEX_BUDGET_SUP = {
    year: "2026",
    type: "suplementar",
    status: "approved",
    notes: "Obras telhado",
    fcrPercentage: "0.00",
    fcrAmount: 0,
    totalAmount: 30000,
    approvedAt: "2026-07-10T00:00:00+00:00",
    installments: 3,
    lines: [{
      categoryCode: "OBR",
      categoryName: "Reparação telhado",
      categoryDescription: null,
      annualAmount: 30000,
    }],
  };
  const ANNEX_QUOTA_SUP = {
    units: [
      {
        unitDesignation: "1.º Dto",
        identifier: "A",
        unitPermillage: "600.000",
        monthlyBaseCents: 0,
        monthlyFcrCents: 0,
        monthlyTotalCents: 6000,
        annualTotalCents: 18000,
      },
      {
        unitDesignation: "2.º Esq",
        identifier: "B",
        unitPermillage: "400.000",
        monthlyBaseCents: 0,
        monthlyFcrCents: 0,
        monthlyTotalCents: 4000,
        annualTotalCents: 12000,
      },
    ],
    totalPermillage: "1000.000",
    totals: {
      monthlyBaseCents: 0,
      monthlyFcrCents: 0,
      monthlyTotalCents: 10000,
      annualTotalCents: 30000,
    },
    fromCharges: false,
  };

  async function renderWithAnnexes() {
    return await renderTemplate("assembly_minutes.vto", {
      condominium: CONDO,
      assembly: {
        title: "Assembleia Geral Ordinária 2026",
        minutesNumber: "42",
        convocationRound: "first",
        scheduledAt: "2026-07-10T19:00:00+00:00",
        location: "Sala",
      },
      decisions: [
        {
          sequence: 1,
          subject: "Aprovação do orçamento principal 2026",
          itemType: "approve_budget",
          votesInFavor: "1000.000",
          votesAgainst: "0.000",
          votesAbstain: "0.000",
          approved: true,
          annexNumber: 2,
        },
        {
          sequence: 2,
          subject: "Aprovação do orçamento suplementar (telhado)",
          itemType: "approve_budget",
          votesInFavor: "1000.000",
          votesAgainst: "0.000",
          votesAbstain: "0.000",
          approved: true,
          annexNumber: 3,
        },
      ],
      attendees: [],
      presentPermillage: 1000,
      presidentName: null,
      secretaryName: null,
      // Anexo 1 é sempre a folha de presenças; os orçamentos começam no Anexo 2.
      annexes: [
        {
          label: "Anexo 2",
          budget: ANNEX_BUDGET,
          quotaMap: ANNEX_QUOTA,
          grandTotal: 132000,
          installmentValue: null,
        },
        {
          label: "Anexo 3",
          budget: ANNEX_BUDGET_SUP,
          quotaMap: ANNEX_QUOTA_SUP,
          grandTotal: 30000,
          installmentValue: 10000,
        },
      ],
      generatedAt: "2026-07-12T10:30:00+00:00",
    });
  }

  it("referência 'ver Anexo N' injetada na deliberação do orçamento ligado", async () => {
    const html = await renderWithAnnexes();
    // WHY: a deliberação tem de apontar para o anexo certo - é o elo que torna a
    // ata legível ("o orçamento votado está no Anexo N"). Os orçamentos começam
    // no Anexo 2 (o Anexo 1 é a folha de presenças).
    assertStringIncludes(html, "Orçamento e mapa de quotas: ver Anexo 2.");
    assertStringIncludes(html, "Orçamento e mapa de quotas: ver Anexo 3.");
    // A referência fica no corpo (ordem do dia), o anexo só depois das assinaturas.
    assert(
      html.indexOf("ver Anexo 2") < html.indexOf("Anexo 2 - Orçamento 2026"),
      "a referência precede o anexo correspondente",
    );
  });

  it("anexo: título numerado + tipo/ano do orçamento, em página nova", async () => {
    const html = await renderWithAnnexes();
    assertStringIncludes(html, 'class="annex"');
    // Anexo 1 = folha de presenças; orçamentos a partir do Anexo 2.
    assertStringIncludes(html, "Anexo 1 - Folha de Presenças");
    assertStringIncludes(html, "Anexo 2 - Orçamento 2026");
    assertStringIncludes(html, "Anexo 3 - Orçamento Suplementar 2026");
    // Ordem dos anexos: folha de presenças primeiro, depois a ordem da ordem do dia.
    assert(
      html.indexOf("Anexo 1 - Folha de Presenças") < html.indexOf("Anexo 2 - Orçamento 2026"),
      "a folha de presenças (Anexo 1) precede os anexos de orçamento",
    );
    assert(
      html.indexOf("Anexo 2 - Orçamento 2026") <
        html.indexOf("Anexo 3 - Orçamento Suplementar 2026"),
      "Anexo 2 antes do Anexo 3",
    );
  });

  it("anexo principal: rubricas + mapa de quotas mensal com os mesmos valores", async () => {
    const html = await renderWithAnnexes();
    assertStringIncludes(html, "Despesas previstas");
    assertStringIncludes(html, "Manutenção elevador");
    assertStringIncludes(html, "Mapa de quotas por fração (mensal)");
    // WHY: o valor por fração tem de bater certo com a página do orçamento -
    // permilagem + total anual cobrado a cada fração.
    assertStringIncludes(html, "600.000 ‰");
    assertStringIncludes(html, "792,00 €");
    assertStringIncludes(html, "528,00 €");
    assertStringIncludes(html, "FCR 10.00%");
    // fromCharges=true -> nota de valores reais.
    assertStringIncludes(html, "Valores reais cobrados às frações.");
  });

  it("anexo suplementar: repartição por prestação + nº e valor das prestações", async () => {
    const html = await renderWithAnnexes();
    assertStringIncludes(html, "Reparação telhado");
    assertStringIncludes(html, "Repartição por fração (por prestação)");
    assertStringIncludes(html, "3 prestações");
    // installmentValue 10000 -> "100,00 €" por prestação.
    assertStringIncludes(html, "100,00 €");
    // fromCharges=false -> nota de previsão.
    assertStringIncludes(html, "Valores que serão cobrados a cada fração ao gerar as quotas.");
  });

  it("sem em-dash (convenção do projeto) nos anexos", async () => {
    const html = await renderWithAnnexes();
    assert(!html.includes("—"), "anexos não devem conter em-dash");
  });

  it("ponto 'Aprovar orçamento' sem orçamento ligado: sem anexo nem referência", async () => {
    // Sem refId, minutes_pdf.ts não define annexNumber nem passa annexes: o ponto
    // delibera normalmente, mas não há "ver Anexo" nem corpo de orçamento anexado.
    const html = await renderTemplate("assembly_minutes.vto", {
      condominium: CONDO,
      assembly: {
        title: "AG",
        minutesNumber: "9",
        convocationRound: "first",
        scheduledAt: "2026-07-10T19:00:00+00:00",
        location: "Sala",
      },
      decisions: [{
        sequence: 1,
        subject: "Aprovação do orçamento 2026",
        itemType: "approve_budget",
        votesInFavor: "1000.000",
        votesAgainst: "0.000",
        votesAbstain: "0.000",
        approved: true,
      }],
      attendees: [],
      presentPermillage: 1000,
      presidentName: null,
      secretaryName: null,
      generatedAt: "2026-07-12T10:30:00+00:00",
    });
    assertStringIncludes(html, "Aprovação do orçamento 2026");
    assert(!html.includes("ver Anexo"), "sem orçamento ligado não injeta referência");
    // A folha de presenças (Anexo 1) está sempre presente; o que não existe é o
    // anexo de orçamento (Anexo 2+).
    assertStringIncludes(html, "Anexo 1 - Folha de Presenças");
    assert(!html.includes("Anexo 2"), "sem orçamento ligado não há anexo de orçamento");
    assert(
      !html.includes("Despesas previstas"),
      "sem orçamento ligado não há corpo de orçamento anexado",
    );
  });
});

describe("template assembly_minutes.vto (ata) - minoria nomeada (votos contra/abstenção)", () => {
  function renderDecision(decision: Record<string, unknown>) {
    return renderTemplate("assembly_minutes.vto", {
      condominium: CONDO,
      assembly: {
        title: "AG",
        minutesNumber: "10",
        convocationRound: "first",
        scheduledAt: "2026-07-10T19:00:00+00:00",
        location: "Sala",
      },
      decisions: [decision],
      attendees: [],
      presentPermillage: 1000,
      presidentName: null,
      secretaryName: null,
      generatedAt: "2026-07-12T10:30:00+00:00",
    });
  }

  it("aprovada com discordantes: nomeia frações contra e abstenções, com identifier", async () => {
    const html = await renderDecision({
      sequence: 1,
      subject: "Uso do fundo comum de reserva",
      itemType: "other",
      votesInFavor: "700.000",
      votesAgainst: "200.000",
      votesAbstain: "100.000",
      approved: true,
      dissentAgainst: [
        { designation: "A", identifier: "Bloco 1 - 1.º Dto" },
        { designation: "C", identifier: "Bloco 2 - 2.º Esq" },
      ],
      dissentAbstain: [{ designation: "B", identifier: "Bloco 1 - 1.º Esq" }],
    });
    // WHY: numa deliberação aprovada, identificar a minoria discordante é o que
    // permite a esses condóminos impugná-la (Art. 1433.º CC) - a fração tem de
    // vir com o identifier (ninguém a reconhece só pela letra).
    assertStringIncludes(html, "Votaram contra:");
    assertStringIncludes(html, "A - Bloco 1 - 1.º Dto");
    assertStringIncludes(html, "C - Bloco 2 - 2.º Esq");
    assertStringIncludes(html, "Abstiveram-se:");
    assertStringIncludes(html, "B - Bloco 1 - 1.º Esq");
  });

  it("aprovada por unanimidade (sem discordantes): não escreve nenhuma linha de minoria", async () => {
    const html = await renderDecision({
      sequence: 1,
      subject: "Aprovação de contas",
      itemType: "accounts_approval",
      votesInFavor: "1000.000",
      votesAgainst: "0.000",
      votesAbstain: "0.000",
      approved: true,
      dissentAgainst: [],
      dissentAbstain: [],
    });
    assert(!html.includes("Votaram contra:"), "sem votos contra não escreve a linha");
    assert(!html.includes("Abstiveram-se:"), "sem abstenções não escreve a linha");
  });

  it("aprovada só com votos contra: escreve só a linha 'Votaram contra'", async () => {
    const html = await renderDecision({
      sequence: 1,
      subject: "Obras na fachada",
      itemType: "other",
      votesInFavor: "600.000",
      votesAgainst: "400.000",
      votesAbstain: "0.000",
      approved: true,
      dissentAgainst: [{ designation: "Loja 1", identifier: null }],
      dissentAbstain: [],
    });
    assertStringIncludes(html, "Votaram contra:");
    // Fração sem identifier mostra só a designação (sem separador pendurado).
    assertStringIncludes(html, "Loja 1");
    assert(!html.includes("Loja 1 -"), "fração sem identifier não leva ' - '");
    assert(!html.includes("Abstiveram-se:"), "sem abstenções não escreve essa linha");
  });

  it("deliberação rejeitada: minutes_pdf não popula minoria -> sem secção", async () => {
    // approved=false: o builder não define dissent*; a folha não nomeia ninguém
    // (só se informa a minoria quando a deliberação ganha).
    const html = await renderDecision({
      sequence: 1,
      subject: "Proposta rejeitada",
      itemType: "other",
      votesInFavor: "300.000",
      votesAgainst: "700.000",
      votesAbstain: "0.000",
      approved: false,
    });
    assertStringIncludes(html, "Rejeitada");
    assert(!html.includes("Votaram contra:"), "rejeitada não nomeia minoria");
    assert(!html.includes("Abstiveram-se:"), "rejeitada não nomeia minoria");
  });
});
