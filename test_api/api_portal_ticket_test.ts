// E2E: /v1/portal/condominiums/:cid/units/:unitId/tickets/...
//
// Cobre o ciclo de vida do ticket vista do condómino:
//   • list, create, get, patch, delete (state-gated)
//   • cross-unit IDOR (Alice não vê ticket de Bob)
//   • cross-condo IDOR (Alice não vê condoB)
//   • filtragem de comments internos (admin marca isInternal=true →
//     portal nunca vê)
//   • restrição de delete: só status='open'
//   • 401 sem auth

import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAs, loginAsSuper } from "./_helpers/auth.ts";
import { seedTestUser, sqlExec } from "./_helpers/db.ts";
import { assertRejects } from "@std/assert";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

describe("portal tickets - CRUD + IDOR + state machine + public comments", () => {
  let condoA: Condominium;
  let condoB: Condominium;
  let unitA1: Unit;
  let unitA2: Unit;
  let unitB1: Unit;
  let aliceHeaders: { Authorization: string };
  let _bobHeaders: { Authorization: string };

  // Tickets criados durante a setup; ids guardados para os testes.
  let ticketA1Id = "";
  let ticketA2Id = "";
  let ticketB1Id = "";

  it("setup: 2 condos, 3 unidades, 2 occupants, 3 tickets (1 por unit)", async () => {
    const ts = Date.now();
    condoA = (await client.super.createCondominium(
      { name: `Portal Ticket A ${ts}` },
      { headers: MASTER },
    )).data;
    condoB = (await client.super.createCondominium(
      { name: `Portal Ticket B ${ts}` },
      { headers: MASTER },
    )).data;
    unitA1 = (await client.super.createUnit(
      condoA.id,
      { designation: "A1", permillage: 100 },
      { headers: MASTER },
    )).data;
    unitA2 = (await client.super.createUnit(
      condoA.id,
      { designation: "A2", permillage: 100 },
      { headers: MASTER },
    )).data;
    unitB1 = (await client.super.createUnit(
      condoB.id,
      { designation: "B1", permillage: 100 },
      { headers: MASTER },
    )).data;

    const aliceEmail = `alice-pt-${ts}@example.pt`;
    const bobEmail = `bob-pt-${ts}@example.pt`;
    const aliceUid = await seedTestUser({
      email: aliceEmail,
      password: "test12345",
      name: "Alice",
      active: true,
    });
    const bobUid = await seedTestUser({
      email: bobEmail,
      password: "test12345",
      name: "Bob",
      active: true,
    });
    // Alice é owner da unitA1 (em condoA); Bob é owner da unitB1 (condoB).
    // Linhas SQL directas - não há endpoint super para criar
    // (occupant + unit_occupant) num só passo.
    const aliceOcc = (await sqlExec(`
      INSERT INTO core.occupant (user_id,name,email,condominium_id)
      VALUES ('${aliceUid}','Alice','${aliceEmail}','${condoA.id}')
      RETURNING id`)).split("\n")[0].trim();
    const bobOcc = (await sqlExec(`
      INSERT INTO core.occupant (user_id,name,email,condominium_id)
      VALUES ('${bobUid}','Bob','${bobEmail}','${condoB.id}')
      RETURNING id`)).split("\n")[0].trim();
    await sqlExec(`
      INSERT INTO core.unit_occupant (unit_id,occupant_id,relationship_type,start_date)
      VALUES ('${unitA1.id}','${aliceOcc}','owner',CURRENT_DATE);
      INSERT INTO core.unit_occupant (unit_id,occupant_id,relationship_type,start_date)
      VALUES ('${unitB1.id}','${bobOcc}','owner',CURRENT_DATE);
    `);
    aliceHeaders = await loginAs(aliceEmail, "test12345");
    _bobHeaders = await loginAs(bobEmail, "test12345");

    // Cria 3 tickets (1 por unit) via admin - para os testes de IDOR e
    // filtragem terem dados pré-existentes.
    // Visibilidade: tickets admin defaultam
    // `admin_only` - invisíveis ao portal. Para o teste do portal os
    // tickets têm de ser `admin_unit` (visíveis aos ocupantes da fração),
    // que era o comportamento implícito antigo do `isPublic=false + unit_id`.
    const tA1 = await client.admin.createTicket(
      {
        title: "Avaria elevador A1",
        category: "elevator",
        unitId: unitA1.id,
        priority: "normal",
        visibility: "admin_unit",
      },
      { headers: { ...MASTER, "x-condominium-id": condoA.id } },
    );
    ticketA1Id = String(tA1.data.id);
    const tA2 = await client.admin.createTicket(
      {
        title: "Avaria luz A2",
        category: "lighting",
        unitId: unitA2.id,
        priority: "normal",
        visibility: "admin_unit",
      },
      { headers: { ...MASTER, "x-condominium-id": condoA.id } },
    );
    ticketA2Id = String(tA2.data.id);
    const tB1 = await client.admin.createTicket(
      {
        title: "B1 issue",
        category: "other",
        unitId: unitB1.id,
        priority: "normal",
        visibility: "admin_unit",
      },
      { headers: { ...MASTER, "x-condominium-id": condoB.id } },
    );
    ticketB1Id = String(tB1.data.id);
    assertExists(ticketA1Id);
    assertExists(ticketA2Id);
    assertExists(ticketB1Id);
  });

  // ── List ──────────────────────────────────────────────────────────────

  it("list: alice vê só os tickets da SUA unit (A1)", async () => {
    const r = await client.portal.listTickets(unitA1.id, {
      headers: { ...aliceHeaders, "x-condominium-id": condoA.id },
    });
    assertEquals(r.status, 200);
    const ids = r.data.map((t) => String((t as { id: string }).id));
    assertEquals(ids.includes(ticketA1Id), true);
    assertEquals(ids.includes(ticketA2Id), false); // outra unit
  });

  // ── Get single ────────────────────────────────────────────────────────

  it("get: alice GET ticket da sua unit → 200 com data", async () => {
    const r = await client.portal.getTicket(unitA1.id, ticketA1Id, {
      headers: { ...aliceHeaders, "x-condominium-id": condoA.id },
    });
    assertEquals(r.status, 200);
    assertEquals(String((r.data as { id: string }).id), ticketA1Id);
  });

  it("get: cross-unit IDOR - alice tenta ver ticket de A2 via path /A1/ → 404", async () => {
    // A1 path mas ticketA2Id no :ticketId - o cross-unit guard tem que
    // bloquear (devolve 404 sem revelar existência).
    const e = await assertRejects(
      () =>
        client.portal.getTicket(unitA1.id, ticketA2Id, {
          headers: { ...aliceHeaders, "x-condominium-id": condoA.id },
        }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("get: cross-condo IDOR - alice tenta ver ticket de condoB → 403/404", async () => {
    const e = await assertRejects(
      () =>
        client.portal.getTicket(unitB1.id, ticketB1Id, {
          headers: { ...aliceHeaders, "x-condominium-id": condoB.id },
        }),
      ApiError,
    );
    // O middleware de portal-access dispara antes do nosso guard.
    assertEquals([403, 404].includes(e.statusCode), true);
  });

  // ── Update ────────────────────────────────────────────────────────────

  it("patch: alice edita campos descritivos (title, location, priority)", async () => {
    const r = await client.portal.updateTicket(
      unitA1.id,
      ticketA1Id,
      { title: "Avaria elevador (urgente)", priority: "high", location: "Hall 2º" },
      { headers: { ...aliceHeaders, "x-condominium-id": condoA.id } },
    );
    assertEquals(r.status, 200);
    const t = r.data as { title: string; priority: string; location: string };
    assertEquals(t.title, "Avaria elevador (urgente)");
    assertEquals(t.priority, "high");
    assertEquals(t.location, "Hall 2º");
  });

  it("patch: cross-unit IDOR - alice tenta editar ticket de A2 → 404", async () => {
    const e = await assertRejects(
      () =>
        client.portal.updateTicket(
          unitA1.id, // path = A1 (alice's)
          ticketA2Id, // ticket da A2 (alice não tem acesso)
          { title: "ataque" },
          { headers: { ...aliceHeaders, "x-condominium-id": condoA.id } },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  // ── Public comments only ─────────────────────────────────────────────

  it("get: comments com isInternal=true não aparecem no portal", async () => {
    // Admin adiciona 2 comments ao ticketA1: 1 público + 1 interno.
    const adminHdr = { ...MASTER, "x-condominium-id": condoA.id };
    await client.admin.addTicketComment(
      ticketA1Id,
      { comment: "Comentário público", isInternal: false },
      { headers: adminHdr },
    );
    await client.admin.addTicketComment(
      ticketA1Id,
      { comment: "Nota interna", isInternal: true },
      { headers: adminHdr },
    );

    const r = await client.portal.getTicket(unitA1.id, ticketA1Id, {
      headers: { ...aliceHeaders, "x-condominium-id": condoA.id },
    });
    const comments = (r.data as { comments: Array<{ comment: string }> }).comments;
    const texts = comments.map((c) => c.comment);
    assertEquals(texts.includes("Comentário público"), true);
    assertEquals(texts.includes("Nota interna"), false); // filtrado!
  });

  // ── Comments do condómino ────────────────────────────────────────────
  // A conversa é o que torna a notificação bidirecional possível: o condómino
  // responde, o email vai para a caixa do condomínio.

  it("comments: alice comenta na sua ocorrência → 201 e fica público", async () => {
    const r = await client.portal.addTicketComment(
      unitA1.id,
      ticketA1Id,
      "Continua sem funcionar.",
      { headers: { ...aliceHeaders, "x-condominium-id": condoA.id } },
    );
    assertEquals(r.status, 201);
    const comments = (r.data as { comments: Array<{ comment: string; isInternal: boolean }> })
      .comments;
    const mine = comments.find((c) => c.comment === "Continua sem funcionar.");
    assertExists(mine);
    // Portal nunca escreve notas internas - senão o próprio autor não as veria.
    assertEquals(mine!.isInternal, false);
  });

  it("comments: comentário vazio → 422", async () => {
    const e = await assertRejects(
      () =>
        client.portal.addTicketComment(unitA1.id, ticketA1Id, "   ", {
          headers: { ...aliceHeaders, "x-condominium-id": condoA.id },
        }),
      ApiError,
    );
    assertEquals(e.statusCode, 422);
  });

  it("comments: cross-unit IDOR - alice comenta em ticket da A2 → 404", async () => {
    const e = await assertRejects(
      () =>
        client.portal.addTicketComment(unitA1.id, ticketA2Id, "ataque", {
          headers: { ...aliceHeaders, "x-condominium-id": condoA.id },
        }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("comments: ocorrência fechada já não aceita comentários → 422", async () => {
    const created = await client.portal.createTicket(
      unitA1.id,
      { title: "Ticket para fechar", category: "other" },
      { headers: { ...aliceHeaders, "x-condominium-id": condoA.id } },
    );
    const id = String((created.data as { id: string }).id);
    await client.admin.updateTicket(
      id,
      { status: "closed" },
      { headers: { ...MASTER, "x-condominium-id": condoA.id } },
    );
    const e = await assertRejects(
      () =>
        client.portal.addTicketComment(unitA1.id, id, "tardio", {
          headers: { ...aliceHeaders, "x-condominium-id": condoA.id },
        }),
      ApiError,
    );
    assertEquals(e.statusCode, 422);
  });

  // ── Delete state-gated ───────────────────────────────────────────────

  it("delete: alice apaga ticket open → 204", async () => {
    // Cria um ticket novo só para apagar (estado open por default).
    const created = await client.portal.createTicket(
      unitA1.id,
      { title: "Ticket throwaway", category: "other" },
      { headers: { ...aliceHeaders, "x-condominium-id": condoA.id } },
    );
    const id = String((created.data as { id: string }).id);
    const r = await client.portal.deleteTicket(unitA1.id, id, {
      headers: { ...aliceHeaders, "x-condominium-id": condoA.id },
    });
    assertEquals(r.status, 204);
  });

  it("delete: alice tenta apagar ticket NÃO-open → 422 INVALID_STATE", async () => {
    // Admin move o ticketA1 para in_progress.
    await client.admin.updateTicket(
      ticketA1Id,
      { status: "in_progress" },
      { headers: { ...MASTER, "x-condominium-id": condoA.id } },
    );
    const e = await assertRejects(
      () =>
        client.portal.deleteTicket(unitA1.id, ticketA1Id, {
          headers: { ...aliceHeaders, "x-condominium-id": condoA.id },
        }),
      ApiError,
    );
    assertEquals(e.statusCode, 422);
    // Mensagem deve mencionar o estado "Aberto" para o user perceber.
    assertEquals(e.message.toLowerCase().includes("aberto"), true);
  });

  it("delete: cross-unit IDOR - alice tenta apagar ticket de A2 → 404", async () => {
    const e = await assertRejects(
      () =>
        client.portal.deleteTicket(unitA1.id, ticketA2Id, {
          headers: { ...aliceHeaders, "x-condominium-id": condoA.id },
        }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  // ── Auth ─────────────────────────────────────────────────────────────

  it("401: GET sem Authorization", async () => {
    const r = await fetch(
      `${BASE_URL}/v1/portal/condominiums/${condoA.id}/units/${unitA1.id}/tickets`,
    );
    assertEquals(r.status, 401);
    await r.body?.cancel();
  });

  // ── Admin: deleteTicketComment ───────────────────────────────────────

  it("admin: deleteTicketComment apaga 1 comment do histórico", async () => {
    // Conta comments antes.
    const before = await client.admin.getTicket(ticketA1Id, {
      headers: { ...MASTER, "x-condominium-id": condoA.id },
    });
    const beforeCount = (before.data as { comments: unknown[] }).comments.length;
    // Apanha o id do primeiro comment.
    const commentId = String(
      (before.data as { comments: Array<{ id: string }> }).comments[0].id,
    );

    const r = await client.admin.deleteTicketComment(ticketA1Id, commentId, {
      headers: { ...MASTER, "x-condominium-id": condoA.id },
    });
    assertEquals(r.status, 204);

    const after = await client.admin.getTicket(ticketA1Id, {
      headers: { ...MASTER, "x-condominium-id": condoA.id },
    });
    const afterCount = (after.data as { comments: unknown[] }).comments.length;
    assertEquals(afterCount, beforeCount - 1);
  });

  it("admin: deleteTicketComment de comment inexistente → 404", async () => {
    const e = await assertRejects(
      () =>
        client.admin.deleteTicketComment(ticketA1Id, "comment_inexistente", {
          headers: { ...MASTER, "x-condominium-id": condoA.id },
        }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  // ── Teardown ─────────────────────────────────────────────────────────

  it("teardown", async () => {
    // FK cleanup em dependency order - várias tabelas referenciam
    // condominium_id sem ON DELETE CASCADE, por isso temos de varrer:
    //   ticket_comment → ticket → unit_occupant → occupant → condominium.
    const condos = `'${condoA.id}','${condoB.id}'`;
    await sqlExec(`DELETE FROM core.ticket_comment WHERE condominium_id IN (${condos})`);
    await sqlExec(`DELETE FROM core.ticket WHERE condominium_id IN (${condos})`);
    await sqlExec(`DELETE FROM core.unit_occupant WHERE unit_id IN (
      SELECT id FROM core.unit WHERE condominium_id IN (${condos})
    )`);
    await sqlExec(`DELETE FROM core.occupant WHERE condominium_id IN (${condos})`);
    await sqlExec(`DELETE FROM core.unit WHERE condominium_id IN (${condos})`);
    await sqlExec(`DELETE FROM core.condominium WHERE id IN (${condos})`);
  });
});
