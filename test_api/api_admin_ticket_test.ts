import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

describe("admin tickets - CRUD + comments + attachments", () => {
  let fx: ScenarioFixture;
  let unit: Unit;
  let ticketId = "";

  const hdr = () => fx.hdr();

  it("setup - condominium + unit", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo("Ticket Test Condo")
      .withUnit({ designation: "A", permillage: 100 })
      .build();
    unit = fx.units[0];
  });

  it("listTickets - empty", async () => {
    const { data, status } = await client.admin.listTickets({}, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data, []);
  });

  it("countOpenTickets - 0", async () => {
    const { data } = await client.admin.countOpenTickets({ headers: hdr() });
    assertEquals(data.count, 0);
  });

  it("createTicket - missing title returns 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createTicket(
          { title: "", category: "elevator" } as never,
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("createTicket - invalid category returns 400", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createTicket(
          // deno-lint-ignore no-explicit-any
          { title: "ok", category: "nonsense" as any },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("createTicket - valid returns 201 with code populated (T###, ADR 0023)", async () => {
    const { data, status } = await client.admin.createTicket(
      {
        title: "Elevador parado",
        description: "Avaria intermitente",
        category: "elevator",
        priority: "high",
        unitId: unit.id,
        location: "Piso 2",
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.title, "Elevador parado");
    assertEquals(data.category, "elevator");
    assertEquals(data.priority, "high");
    assertEquals(data.status, "open");
    assertEquals(data.unitId, unit.id);
    // `code` é preenchido pelo trigger `trg_ticket_code_assign` BEFORE INSERT.
    // Formato `T` + 3 dígitos base-36 per-condomínio (ADR 0023); o CHECK aceita ≥3.
    assertEquals(typeof data.code, "string");
    assertEquals(/^T[0-9A-Z]{3,}$/.test(data.code), true);
    assertEquals(data.comments, []);
    assertEquals(data.attachments, []);
    ticketId = data.id;
  });

  it("countOpenTickets - 1 após criação", async () => {
    const { data } = await client.admin.countOpenTickets({ headers: hdr() });
    assertEquals(data.count, 1);
  });

  it("getTicket - retorna ticket criado", async () => {
    const { data, status } = await client.admin.getTicket(ticketId, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data.id, ticketId);
    assertEquals(data.location, "Piso 2");
  });

  it("addTicketComment - comentário público", async () => {
    const { data, status } = await client.admin.addTicketComment(
      ticketId,
      { comment: "Técnico contactado, vem amanhã.", isInternal: false },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.comments.length, 1);
    assertEquals(data.comments[0].comment, "Técnico contactado, vem amanhã.");
    assertEquals(data.comments[0].isInternal, false);
  });

  it("addTicketComment - nota interna", async () => {
    const { data } = await client.admin.addTicketComment(
      ticketId,
      { comment: "Pedi orçamento à empresa Y.", isInternal: true },
      { headers: hdr() },
    );
    assertEquals(data.comments.length, 2);
    const internal = data.comments.find((c) => c.isInternal);
    assertExists(internal);
    assertEquals(internal!.comment, "Pedi orçamento à empresa Y.");
  });

  it("updateTicket - mudança de status gera auto-comment", async () => {
    const { data, status } = await client.admin.updateTicket(
      ticketId,
      { status: "in_progress" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.status, "in_progress");
    // Auto-comment do sistema: statusFrom/To + NÃO-interno, para o condómino
    // ver a transição no portal e receber o email correspondente.
    const sysComment = data.comments.find((c) => c.statusTo === "in_progress");
    assertExists(sysComment);
    assertEquals(sysComment!.statusFrom, "open");
    assertEquals(sysComment!.isInternal, false);
  });

  it("updateTicket - resolved preenche resolvedAt", async () => {
    const { data } = await client.admin.updateTicket(
      ticketId,
      { status: "resolved", resolutionNotes: "Motor substituído." },
      { headers: hdr() },
    );
    assertEquals(data.status, "resolved");
    assertExists(data.resolvedAt);
    assertEquals(data.resolutionNotes, "Motor substituído.");
  });

  it("updateTicket - voltar a open limpa resolvedAt", async () => {
    const { data } = await client.admin.updateTicket(
      ticketId,
      { status: "open" },
      { headers: hdr() },
    );
    assertEquals(data.status, "open");
    assertEquals(data.resolvedAt, null);
  });

  it("listTickets - retorna o ticket criado", async () => {
    const { data } = await client.admin.listTickets({}, { headers: hdr() });
    assertEquals(data.length, 1);
    assertEquals(data[0].id, ticketId);
  });

  it("listTickets - filtro por status=closed devolve vazio", async () => {
    const { data } = await client.admin.listTickets({ status: "closed" }, { headers: hdr() });
    assertEquals(data, []);
  });

  it("listTickets - filtro por unitId", async () => {
    const { data } = await client.admin.listTickets({ unitId: unit.id }, { headers: hdr() });
    assertEquals(data.length, 1);
  });

  // ── Attachments ─────────────────────────────────────────────────────────
  let attachmentId = "";

  it("uploadTicketAttachment - foto JPG", async () => {
    // Bytes mínimos de PNG válido (1x1 pixel transparente).
    const pngBytes = new Uint8Array([
      137,
      80,
      78,
      71,
      13,
      10,
      26,
      10,
      0,
      0,
      0,
      13,
      73,
      72,
      68,
      82,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      8,
      6,
      0,
      0,
      0,
      31,
      21,
      196,
      137,
      0,
      0,
      0,
      13,
      73,
      68,
      65,
      84,
      120,
      156,
      99,
      250,
      207,
      0,
      0,
      0,
      4,
      0,
      1,
      145,
      145,
      209,
      22,
      0,
      0,
      0,
      0,
      73,
      69,
      78,
      68,
      174,
      66,
      96,
      130,
    ]);
    const file = new File([pngBytes], "avaria.png", { type: "image/png" });
    const { data, status } = await client.admin.uploadTicketAttachment(
      ticketId,
      file,
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.filename, "avaria.png");
    assertEquals(data.mimeType, "image/png");
    assertExists(data.fileSize);
    attachmentId = data.id;
  });

  it("getTicket - inclui attachment", async () => {
    const { data } = await client.admin.getTicket(ticketId, { headers: hdr() });
    assertEquals(data.attachments.length, 1);
    assertEquals(data.attachments[0].id, attachmentId);
  });

  it("uploadTicketAttachment - sem ticket retorna 404", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "x.bin", {
      type: "application/octet-stream",
    });
    const e = await assertRejects(
      () =>
        client.admin.uploadTicketAttachment(
          "tkt_inexistente",
          file,
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("deleteTicketAttachment - remove anexo", async () => {
    const { status } = await client.admin.deleteTicketAttachment(
      ticketId,
      attachmentId,
      { headers: hdr() },
    );
    assertEquals(status, 204);
    const { data } = await client.admin.getTicket(ticketId, { headers: hdr() });
    assertEquals(data.attachments.length, 0);
  });

  // ── Delete + 404 ────────────────────────────────────────────────────────
  it("deleteTicket - 204 + soft-delete", async () => {
    const { status } = await client.admin.deleteTicket(ticketId, { headers: hdr() });
    assertEquals(status, 204);
  });

  it("getTicket - 404 após delete (soft-deleted)", async () => {
    const e = await assertRejects(
      () => client.admin.getTicket(ticketId, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("listTickets - vazio após delete", async () => {
    const { data } = await client.admin.listTickets({}, { headers: hdr() });
    assertEquals(data, []);
  });

  // ── teardown ─────────────────────────────────────────────────────────────
  it("cleanup - apaga condomínio", async () => {
    await fx.cleanup();
  });
});
