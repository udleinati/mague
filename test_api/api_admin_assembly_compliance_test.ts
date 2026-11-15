// E2E do compliance legal de assembleias (Código Civil PT, Art. 1430-1434):
//
//   1. POST /assemblies/:id/attendees → registo de presença com permilagem.
//   2. POST attendee com isProxy=true + proxyHolderOccupantId (Art. 1431.º nº 5).
//   3. POST /agenda-items com votes[] (votação por fração - Art. 1432-1433).
//      → trigger SQL agrega para votes_in_favor/against/abstain.
//   4. PATCH /assemblies/:id com president/secretary/signed (Art. 1434.º).
//   5. Lock: depois de status=held, presenças e decisões ficam imutáveis.
//
// Setup auto-contido: 1 condo + 2 units + 2 occupants.

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { sqlExec } from "./_helpers/db.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });

describe("admin assembly - compliance legal (Art. 1430-1434 CC)", () => {
  let auth: { Authorization: string };
  let fx: ScenarioFixture;
  let unitA: Unit;
  let unitB: Unit;
  let assemblyId = "";
  let agendaItemId = "";
  let occupantA = "";
  let occupantB = "";

  it("setup - condo + 2 units + 2 occupants + assembleia em rascunho", async () => {
    auth = await loginAsSuper();
    fx = await seedScenario(client, auth)
      .withCondo("Assembly compliance E2E")
      .withUnit({ designation: "A", permillage: 600 })
      .withUnit({ designation: "B", permillage: 400 })
      .withOccupant({ name: "Owner A", email: "a@test.pt", unitDesignation: "A" })
      .withOccupant({ name: "Owner B", email: "b@test.pt", unitDesignation: "B" })
      .build();
    unitA = fx.units[0];
    unitB = fx.units[1];
    occupantA = fx.occupants[0].id;
    occupantB = fx.occupants[1].id;

    const headers = fx.hdr();
    const { data: a } = await client.admin.createAssembly(
      {
        type: "ordinary",
        scheduledAt: "2099-06-15T19:00:00.000Z",
        location: "Sala 1",
      },
      { headers },
    );
    assemblyId = String(a.id);
  });

  // ─── Ordem do dia (montada em RASCUNHO) ──────────────────────────────────
  // Sob o ciclo de vida draft -> scheduled -> held, as deliberações (pontos
  // da ordem do dia) editam-se em `draft`; as presenças/votos registam-se já
  // convocada. Por isso a deliberação cria-se aqui, antes de convocar.

  it("POST /agenda-items com votes[] em rascunho - trigger agrega para votes_*", async () => {
    const headers = fx.hdr();
    const { data, status } = await client.admin.createAssemblyAgendaItem(
      assemblyId,
      {
        sequence: 1,
        subject: "Aprovar orçamento 2099",
        itemType: "approve_budget",
        votes: [
          { unitId: unitA.id, vote: "favor", permillageApplied: 600 },
          { unitId: unitB.id, vote: "against", permillageApplied: 400 },
        ],
        approved: true,
      },
      { headers },
    );
    assertEquals(status, 201);
    agendaItemId = String(data.id);
    // Trigger fn_assembly_vote_aggregate agrega: 600 favor, 400 contra.
    assertEquals(String(data.votesInFavor), "600.000");
    assertEquals(String(data.votesAgainst), "400.000");
    assertEquals(String(data.votesAbstain), "0.000");
  });

  it("POST /agenda-items é bloqueado depois de convocar (ordem do dia travada)", async () => {
    // Convocar: draft -> scheduled. A partir daqui acrescentar um ponto à
    // ordem do dia é recusado (AGENDA_LOCKED) - foi o que se convocou.
    const headers = fx.hdr();
    await client.admin.updateAssembly(assemblyId, { status: "scheduled" }, { headers });
    const e = await assertRejects(
      () =>
        client.admin.createAssemblyAgendaItem(
          assemblyId,
          { sequence: 2, subject: "Ponto fora da convocatória" },
          { headers },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  it("PATCH /agenda-items em convocada: descrição + referência editáveis, assunto travado", async () => {
    // Convocada (`scheduled`): o assunto/ordem/tipo foi ANUNCIADO na convocatória
    // e fica travado; a descrição e a referência registam-se na deliberação (não
    // vão na convocatória). Ver update_agenda_item.ts + lifecycle.ts.
    const headers = fx.hdr();
    // Orçamento real para referenciar: `ref_type='budget'` exige `ref_id`
    // (constraint ref_consistency) e selar como `held` aprova o orçamento ligado
    // (trigger fn_assembly_held_approve_budgets), que exige >= 1 linha de despesa.
    const cat = (await client.admin.createChartOfAccount(
      { code: "9.9.1", name: "Despesa de teste", type: "expense" },
      { headers },
    )).data;
    const budget = (await client.admin.createBudget({ year: "2099" }, { headers })).data;
    await client.admin.createBudgetLine(
      String(budget.id),
      { accountId: cat.id, annualAmount: 100000 },
      { headers },
    );
    const { data, status } = await client.admin.updateAssemblyAgendaItem(
      assemblyId,
      agendaItemId,
      {
        description: "Aprovado por maioria na reunião",
        refType: "budget",
        refId: String(budget.id),
      },
      { headers },
    );
    assertEquals(status, 200);
    assertEquals(data.description, "Aprovado por maioria na reunião");
    assertEquals(data.refType, "budget");
    assertEquals(data.refId, String(budget.id));

    // O assunto anunciado continua travado (AGENDA_LOCKED).
    const e = await assertRejects(
      () =>
        client.admin.updateAssemblyAgendaItem(
          assemblyId,
          agendaItemId,
          { subject: "Assunto alterado depois de convocar" },
          { headers },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  // ─── Attendees (registados já CONVOCADA) ─────────────────────────────────

  it("POST /attendees - regista presença com permilagem (Art. 1432.º)", async () => {
    const headers = fx.hdr();
    const { data, status } = await client.admin.createAssemblyAttendee(
      assemblyId,
      {
        unitId: unitA.id,
        occupantId: occupantA,
        permillageAtMeeting: 600,
        isProxy: false,
      },
      { headers },
    );
    assertEquals(status, 201);
    assertExists(data.id);
    assertEquals(data.isProxy, false);
  });

  it("POST /attendees - procuração (is_proxy + proxy_holder_occupant_id)", async () => {
    // Owner B é o titular da unit B mas está ausente; Owner A vem como
    // portador da procuração (Art. 1431.º nº 5).
    const headers = fx.hdr();
    const { data, status } = await client.admin.createAssemblyAttendee(
      assemblyId,
      {
        unitId: unitB.id,
        occupantId: occupantB, // titular registado
        permillageAtMeeting: 400,
        isProxy: true,
        proxyHolderOccupantId: occupantA, // owner A é o portador presente
      },
      { headers },
    );
    assertEquals(status, 201);
    assertEquals(data.isProxy, true);
    assertEquals(data.proxyHolderOccupantId, occupantA);
  });

  it("POST /attendees - duplicado para mesma unit → 409", async () => {
    const headers = fx.hdr();
    const e = await assertRejects(
      () =>
        client.admin.createAssemblyAttendee(
          assemblyId,
          {
            unitId: unitA.id,
            occupantId: occupantA,
            permillageAtMeeting: 600,
            isProxy: false,
          },
          { headers },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  it("POST /attendees - is_proxy=true sem proxy_holder → 400", async () => {
    const headers = fx.hdr();
    const e = await assertRejects(
      () =>
        client.admin.createAssemblyAttendee(
          assemblyId,
          {
            unitId: unitB.id,
            occupantId: occupantA,
            permillageAtMeeting: 400,
            isProxy: true,
            // sem proxyHolderOccupantId nem proxyHolderExternalName - refine bloqueia
          },
          { headers },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("GET /attendees - devolve lista (2 entries)", async () => {
    const headers = fx.hdr();
    const { data } = await client.admin.listAssemblyAttendees(assemblyId, { headers });
    assertEquals(data.length, 2);
  });

  // ─── Assinatura da acta (Art. 1434.º) ────────────────────────────────────

  it("PATCH /assemblies - assinatura: president + secretary + signed_at em conjunto", async () => {
    const headers = fx.hdr();
    // Schema espera DATE (YYYY-MM-DD), não timestamp ISO completo
    // (minutes_signed_at é `date`).
    const today = new Date().toISOString().slice(0, 10);
    const { data, status } = await client.admin.updateAssembly(
      assemblyId,
      {
        presidentOccupantId: occupantA,
        secretaryOccupantId: occupantB,
        minutesSignedAt: today,
      },
      { headers },
    );
    assertEquals(status, 200);
    assertEquals(data.presidentOccupantId, occupantA);
    assertEquals(data.secretaryOccupantId, occupantB);
    assertExists(data.minutesSignedAt);
  });

  // ─── Lock após status=held ───────────────────────────────────────────────

  it("após held: POST /attendees → 409 ASSEMBLY_LOCKED", async () => {
    const headers = fx.hdr();
    // Marca como realizada.
    await client.admin.updateAssembly(assemblyId, {
      status: "held",
      heldAt: new Date().toISOString(),
    }, {
      headers,
    });

    // Tentar criar attendee numa unit ainda não usada (unitB já está usada
    // como procuração; reutilizamos unitA mas a constraint UNIQUE bloqueia
    // antes do lock. Para testar especificamente o lock, criamos nova unit
    // depois de held - admin pode criar units depois de held, mas attendees
    // não devem ser editáveis).
    const unitC = (await client.super.createUnit(
      fx.condominium.id,
      { designation: "C", permillage: 100 } as Record<string, unknown>,
      { headers: auth },
    )).data;
    const e = await assertRejects(
      () =>
        client.admin.createAssemblyAttendee(
          assemblyId,
          {
            unitId: unitC.id,
            occupantId: occupantA,
            permillageAtMeeting: 100,
            isProxy: false,
          },
          { headers },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  it("teardown", async () => {
    await sqlExec(`
      DELETE FROM core.assembly_vote WHERE assembly_agenda_item_id IN (
        SELECT id FROM core.assembly_agenda_item WHERE assembly_id = '${assemblyId}'
      );
      DELETE FROM core.assembly_agenda_item WHERE assembly_id = '${assemblyId}';
      DELETE FROM core.assembly_attendee WHERE assembly_id = '${assemblyId}';
      DELETE FROM core.assembly WHERE id = '${assemblyId}';
      DELETE FROM core.unit_occupant WHERE occupant_id IN ('${occupantA}', '${occupantB}');
      DELETE FROM core.occupant WHERE id IN ('${occupantA}', '${occupantB}');
    `);
    await fx.cleanup();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bloqueio server-side de status=held sem quórum (Art. 1432.º nº 1)
// ═══════════════════════════════════════════════════════════════════════════

describe("admin assembly - quórum bloqueia transição held", () => {
  let auth: { Authorization: string };
  let fx: ScenarioFixture;
  let _unitA: Unit;
  let unitB: Unit;
  let assemblyId = "";
  let occA = "";
  let occB = "";

  it("setup - 2 units 600/400, assembleia scheduled", async () => {
    auth = await loginAsSuper();
    fx = await seedScenario(client, auth)
      .withCondo("Phase 2 Quorum")
      .withUnit({ designation: "A", permillage: 600 })
      .withUnit({ designation: "B", permillage: 400 })
      .withOccupant({ name: "QA" })
      .withOccupant({ name: "QB" })
      .build();
    _unitA = fx.units[0];
    unitB = fx.units[1];
    occA = fx.occupants[0].id;
    occB = fx.occupants[1].id;

    const headers = fx.hdr();
    const { data: a } = await client.admin.createAssembly(
      { type: "ordinary", scheduledAt: "2099-09-15T19:00:00.000Z" },
      { headers },
    );
    assemblyId = String(a.id);
  });

  it("held SEM presenças registadas → 200 (modo legacy/informativo: skip)", async () => {
    // Quando o admin não regista nenhum attendee, considera-se "modo
    // informativo" - pulamos validação de quórum (escape hatch).
    const headers = fx.hdr();
    const { status } = await client.admin.updateAssembly(
      assemblyId,
      { status: "held", heldAt: new Date().toISOString() },
      { headers },
    );
    assertEquals(status, 200);
    // Reverter para próximo step (volta a scheduled).
    await sqlExec(
      `UPDATE core.assembly SET status='scheduled', held_at=NULL WHERE id='${assemblyId}'`,
    );
  });

  it("held com 1 attendee a 400/1000 em 1ª convocatória → 422 (não bate maioria estrita)", async () => {
    const headers = fx.hdr();
    await client.admin.createAssemblyAttendee(assemblyId, {
      unitId: unitB.id,
      occupantId: occB,
      permillageAtMeeting: 400,
      isProxy: false,
    }, { headers });

    const e = await assertRejects(
      () =>
        client.admin.updateAssembly(
          assemblyId,
          { status: "held", heldAt: new Date().toISOString() },
          { headers },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 422);
  });

  it("held em 2ª convocatória com 400/1000 → 200 (qualquer permilagem chega)", async () => {
    const headers = fx.hdr();
    const { status } = await client.admin.updateAssembly(
      assemblyId,
      {
        convocationRound: "second",
        status: "held",
        heldAt: new Date().toISOString(),
      },
      { headers },
    );
    assertEquals(status, 200);
  });

  it("teardown - quorum", async () => {
    await sqlExec(`
      DELETE FROM core.assembly_attendee WHERE assembly_id = '${assemblyId}';
      DELETE FROM core.assembly WHERE id = '${assemblyId}';
      DELETE FROM core.occupant WHERE id IN ('${occA}', '${occB}');
    `);
    await fx.cleanup();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Resultado da deliberação DERIVADO dos votos (Art. 1432.º nº 1+3 + 1422.º nº 2).
// O `approved` enviado pelo cliente é IGNORADO - o servidor calcula-o pela regra
// de maioria do item_type (CLAUDE.md Regra 5). Substitui o antigo bloqueio 422
// MAJORITY_NOT_MET: já não se rejeita, deriva-se o resultado correto.
// ═══════════════════════════════════════════════════════════════════════════

describe("admin assembly - resultado derivado dos votos (ignora approved do cliente)", () => {
  let auth: { Authorization: string };
  let fx: ScenarioFixture;
  let assemblyId = "";
  let occA = "";

  it("setup - condo 1000 ‰", async () => {
    auth = await loginAsSuper();
    fx = await seedScenario(client, auth)
      .withCondo("Phase 2 Majority")
      .withUnit({ designation: "A", permillage: 500 })
      .withUnit({ designation: "B", permillage: 500 })
      .withOccupant({ name: "MA" })
      .build();
    occA = fx.occupants[0].id;

    const headers = fx.hdr();
    const { data: a } = await client.admin.createAssembly(
      { type: "ordinary", scheduledAt: "2099-10-15T19:00:00.000Z" },
      { headers },
    );
    assemblyId = String(a.id);
  });

  it("approve_budget (simple) 250 favor vs 750 contra → 201, derivado = reprovada (ignora approved:true)", async () => {
    const headers = fx.hdr();
    const { data, status } = await client.admin.createAssemblyAgendaItem(
      assemblyId,
      {
        sequence: 1,
        subject: "Orçamento reprovado pelos votos",
        itemType: "approve_budget",
        votesInFavor: 250,
        votesAgainst: 750,
        votesAbstain: 0,
        approved: true, // ignorado: o servidor deriva o resultado dos votos
      },
      { headers },
    );
    assertEquals(status, 201);
    assertEquals(data.approved, false);
  });

  it("approve_budget (simple) 600 favor vs 400 contra → 201, derivado = aprovada", async () => {
    const headers = fx.hdr();
    const { data, status } = await client.admin.createAssemblyAgendaItem(
      assemblyId,
      {
        sequence: 2,
        subject: "Orçamento aprovado",
        itemType: "approve_budget",
        votesInFavor: 600,
        votesAgainst: 400,
        votesAbstain: 0,
      },
      { headers },
    );
    assertEquals(status, 201);
    assertEquals(data.approved, true);
  });

  it("approve_fcr_usage (2/3) 600/1000 favor → 201, derivado = reprovada (60% < 66.7%, ignora approved:true)", async () => {
    const headers = fx.hdr();
    const { data, status } = await client.admin.createAssemblyAgendaItem(
      assemblyId,
      {
        sequence: 3,
        subject: "FCR para obra (600/1000 = 60%)",
        itemType: "approve_fcr_usage",
        votesInFavor: 600,
        votesAgainst: 400,
        votesAbstain: 0,
        approved: true, // ignorado
      },
      { headers },
    );
    assertEquals(status, 201);
    assertEquals(data.approved, false);
  });

  it("approve_fcr_usage (2/3) 700/1000 favor → 201, derivado = aprovada", async () => {
    const headers = fx.hdr();
    const { data, status } = await client.admin.createAssemblyAgendaItem(
      assemblyId,
      {
        sequence: 4,
        subject: "FCR para obra (700/1000 = 70%)",
        itemType: "approve_fcr_usage",
        votesInFavor: 700,
        votesAgainst: 300,
        votesAbstain: 0,
      },
      { headers },
    );
    assertEquals(status, 201);
    assertEquals(data.approved, true);
  });

  it("sem votos (totais a 0) → 201, resultado fica pendente (null)", async () => {
    const headers = fx.hdr();
    const { data, status } = await client.admin.createAssemblyAgendaItem(
      assemblyId,
      {
        sequence: 5,
        subject: "Ponto ainda não votado",
        itemType: "approve_budget",
      },
      { headers },
    );
    assertEquals(status, 201);
    assertEquals(data.approved, null);
  });

  it("teardown - majority", async () => {
    await sqlExec(`
      DELETE FROM core.assembly_agenda_item WHERE assembly_id = '${assemblyId}';
      DELETE FROM core.assembly WHERE id = '${assemblyId}';
      DELETE FROM core.occupant WHERE id = '${occA}';
    `);
    await fx.cleanup();
  });
});
