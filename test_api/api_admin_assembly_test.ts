import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

describe("admin assemblies + decisions", () => {
  let fx: ScenarioFixture;
  let assemblyId = "";
  let agendaItemId = "";

  const hdr = () => fx.hdr();

  it("setup - create condominium", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo("Assembly Test Condo")
      .build();
  });

  it("listAssemblies - empty", async () => {
    const { data, status } = await client.admin.listAssemblies({}, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data, []);
  });

  it("createAssembly - missing fields returns 400", async () => {
    const e = await assertRejects(
      () => client.admin.createAssembly({}, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("createAssembly - valid returns 201", async () => {
    const { data, status } = await client.admin.createAssembly(
      {
        type: "ordinary",
        scheduledAt: "2026-06-15T19:00:00+00:00",
        location: "Sala do condomínio",
        minutesNumber: "AT-01/2026",
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.type, "ordinary");
    assemblyId = data.id as string;
  });

  it("getAssembly - returns created", async () => {
    const { data, status } = await client.admin.getAssembly(assemblyId, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data.id, assemblyId);
  });

  // Deliberações têm de ser criadas ANTES de marcar como held - após held
  // a assembleia fica selada (409 ASSEMBLY_LOCKED) para qualquer edição.
  it("createAssemblyAgendaItem - deliberação aprovada retorna 201", async () => {
    const { data, status } = await client.admin.createAssemblyAgendaItem(
      assemblyId,
      {
        sequence: 1,
        subject: "Aprovação do orçamento 2026",
        itemType: "other",
        approved: true,
        votesInFavor: 5,
        votesAgainst: 0,
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.approved, true);
    agendaItemId = data.id as string;
  });

  // Teste: edição da deliberação antes de held.
  it("updateAssemblyAgendaItem - altera subject/description/votos", async () => {
    const { data, status } = await client.admin.updateAssemblyAgendaItem(
      assemblyId,
      agendaItemId,
      {
        subject: "Aprovação do orçamento 2026 (revisto)",
        description: "Actualizar descrição após discussão",
        votesInFavor: 7,
        votesAgainst: 1,
      },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.subject, "Aprovação do orçamento 2026 (revisto)");
    assertEquals(String(data.votesInFavor), "7.000");
  });

  // Informativa (itemType=info) - valida que cria sem votos/approved.
  it("createAssemblyAgendaItem - tipo 'info' sem votos retorna 201", async () => {
    const { data, status } = await client.admin.createAssemblyAgendaItem(
      assemblyId,
      {
        sequence: 2,
        subject: "Outros assuntos",
        description: "Discutido o tema X",
        itemType: "info",
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.itemType, "info");
  });

  // Deliberações devem ser ordenadas por `sequence` no retrieve.
  it("getAssembly - deliberações vêm ordenadas por sequence", async () => {
    // Criar uma deliberação com sequence=99 e outra com sequence=3 fora de ordem.
    // Tipo `info` (não se votam): senão ficavam por deliberar e bloqueavam o
    // `held` mais abaixo (Art. 1432.º - selar exige todos os pontos deliberados).
    await client.admin.createAssemblyAgendaItem(
      assemblyId,
      { sequence: 99, subject: "Ponto 99", itemType: "info" },
      { headers: hdr() },
    );
    await client.admin.createAssemblyAgendaItem(
      assemblyId,
      { sequence: 3, subject: "Ponto 3", itemType: "info" },
      { headers: hdr() },
    );
    const { data } = await client.admin.getAssembly(assemblyId, { headers: hdr() });
    const seqs = (data.agendaItems as Array<{ sequence: number }>).map((d) => d.sequence);
    const sorted = [...seqs].sort((a, b) => a - b);
    assertEquals(seqs, sorted);
  });

  // Delete da deliberação enquanto scheduled.
  it("deleteAssemblyAgendaItem - scheduled returns 204", async () => {
    const { data: tmp } = await client.admin.createAssemblyAgendaItem(
      assemblyId,
      { sequence: 50, subject: "Temporária" },
      { headers: hdr() },
    );
    const { status } = await client.admin.deleteAssemblyAgendaItem(
      assemblyId,
      tmp.id as string,
      { headers: hdr() },
    );
    assertEquals(status, 204);
  });

  it("createAssemblyAgendaItem - missing subject returns 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createAssemblyAgendaItem(
          assemblyId,
          { sequence: 2 },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("updateAssembly - mudar status para held retorna 200", async () => {
    const { data, status } = await client.admin.updateAssembly(
      assemblyId,
      { status: "held", heldAt: "2026-06-15T19:30:00+00:00" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.status, "held");
  });

  // Após held, qualquer edição é bloqueada (ASSEMBLY_LOCKED).
  it("createAssemblyAgendaItem - on held returns 409", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createAssemblyAgendaItem(
          assemblyId,
          { sequence: 99, subject: "Tentativa pós-held" },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  it("updateAssembly - on held returns 409", async () => {
    const e = await assertRejects(
      () =>
        client.admin.updateAssembly(
          assemblyId,
          { location: "Outro sítio" },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  it("deleteAssembly - on held returns 409", async () => {
    const e = await assertRejects(
      () => client.admin.deleteAssembly(assemblyId, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  // Edição de deliberações após held também está bloqueada.
  it("updateAssemblyAgendaItem - on held returns 409", async () => {
    const e = await assertRejects(
      () =>
        client.admin.updateAssemblyAgendaItem(
          assemblyId,
          agendaItemId,
          { description: "Não permitido" },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  it("deleteAssemblyAgendaItem - on held returns 409", async () => {
    const e = await assertRejects(
      () => client.admin.deleteAssemblyAgendaItem(assemblyId, agendaItemId, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  // Cria uma assembleia só para testar o delete enquanto ainda scheduled.
  it("deleteAssembly - scheduled returns 204", async () => {
    const { data: scheduled } = await client.admin.createAssembly(
      {
        type: "extraordinary",
        scheduledAt: "2027-03-10T18:00:00+00:00",
      },
      { headers: hdr() },
    );
    const { status } = await client.admin.deleteAssembly(scheduled.id as string, {
      headers: hdr(),
    });
    assertEquals(status, 204);
  });

  it("teardown - delete condominium", async () => {
    await fx.cleanup();
  });
});
