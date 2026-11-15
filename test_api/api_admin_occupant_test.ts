import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  ApiError,
  Client,
  type Condominium,
  type Occupant,
  type Unit,
} from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

describe("admin occupants + unit_occupants", () => {
  let fx: ScenarioFixture;
  let condo: Condominium;
  let unit: Unit;
  let occupant: Occupant;
  let unitOccupantId = "";

  const hdr = () => fx.hdr();

  it("setup - condominium + unit", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo("Occupant CRUD Condo")
      .withUnit({ designation: "A", permillage: 100 })
      .build();
    condo = fx.condominium;
    unit = fx.units[0];
  });

  it("listOccupants - empty", async () => {
    const { data, status } = await client.admin.listOccupants({}, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data, []);
  });

  it("createOccupant - missing name returns 400", async () => {
    const e = await assertRejects(
      () => client.admin.createOccupant({}, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("createOccupant - valid payload returns 201", async () => {
    const { data, status } = await client.admin.createOccupant(
      { name: "João Silva", email: "joao@example.pt", nif: "123456789" },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.name, "João Silva");
    occupant = data;
  });

  it("getOccupant - returns 200", async () => {
    const { data, status } = await client.admin.getOccupant(occupant.id, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data.id, occupant.id);
  });

  it("getOccupant - non-existent returns 404", async () => {
    const e = await assertRejects(
      () => client.admin.getOccupant("00000000000000000000000", { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("updateOccupant - change phone returns 200", async () => {
    const { data, status } = await client.admin.updateOccupant(
      occupant.id,
      { phone: "+351 919999999" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.phone, "+351 919999999");
  });

  it("listUnitOccupants - unit is empty initially", async () => {
    const { data } = await client.admin.listUnitOccupants(unit.id, { headers: hdr() });
    assertEquals(data, []);
  });

  it("createUnitOccupant - link occupant to unit returns 201", async () => {
    const { data, status } = await client.admin.createUnitOccupant(
      unit.id,
      { unitId: unit.id, occupantId: occupant.id, relationshipType: "owner" },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.unitId, unit.id);
    assertEquals(data.occupantId, occupant.id);
    unitOccupantId = data.id;
  });

  it("createUnitOccupant - duplicate active link returns 409", async () => {
    const e = await assertRejects(
      () =>
        client.admin.createUnitOccupant(
          unit.id,
          { unitId: unit.id, occupantId: occupant.id, relationshipType: "owner" },
          { headers: hdr() },
        ),
      ApiError,
    );
    assertEquals(e.statusCode, 409);
  });

  it("listUnitOccupants - shows linked occupant", async () => {
    const { data } = await client.admin.listUnitOccupants(unit.id, { headers: hdr() });
    assertEquals(data.length, 1);
  });

  it("getUnitOccupant - returns the link", async () => {
    const { data, status } = await client.admin.getUnitOccupant(unit.id, unitOccupantId, {
      headers: hdr(),
    });
    assertEquals(status, 200);
    assertEquals(data.id, unitOccupantId);
  });

  // ── updateUnitOccupant: campo `endDate` ──────────────────────────────
  // Cobertura para o modal "Editar associação" da página do ocupante,
  // que permite definir Desde/Até. Verifica:
  //   1. SET endDate → DB grava
  //   2. Mudar relationshipType + startDate em conjunto
  //   3. CLEAR endDate (null) → volta a "ativa"

  it("updateUnitOccupant - set endDate marca associação como terminada", async () => {
    const { data, status } = await client.admin.updateUnitOccupant(
      unit.id,
      unitOccupantId,
      { endDate: "2099-06-30" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.endDate, "2099-06-30");
  });

  it("updateUnitOccupant - relationshipType + startDate em conjunto", async () => {
    const { data, status } = await client.admin.updateUnitOccupant(
      unit.id,
      unitOccupantId,
      { relationshipType: "tenant", startDate: "2099-01-15" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.relationshipType, "tenant");
    assertEquals(data.startDate, "2099-01-15");
    // endDate persiste (não foi tocado no payload)
    assertEquals(data.endDate, "2099-06-30");
  });

  it("updateUnitOccupant - endDate=null limpa (volta a ativa)", async () => {
    const { data, status } = await client.admin.updateUnitOccupant(
      unit.id,
      unitOccupantId,
      { endDate: null },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.endDate, null);
  });

  it("deleteUnitOccupant - returns 204", async () => {
    const { status } = await client.admin.deleteUnitOccupant(unit.id, unitOccupantId, {
      headers: hdr(),
    });
    assertEquals(status, 204);
  });

  it("deleteUnitOccupantByOccupant - desliga via path occupantId", async () => {
    // Re-cria o link para testar a variante by-occupant. Útil em cenários
    // onde o admin quer remover um occupant duma fração mas não tem o
    // unit_occupant.id à mão (apenas o occupant.id).
    const { data: link } = await client.admin.createUnitOccupant(
      unit.id,
      {
        unitId: unit.id,
        occupantId: occupant.id,
        relationshipType: "owner",
        startDate: "2025-01-01",
      },
      { headers: hdr() },
    );
    // Confirma que existe.
    const { data: list1 } = await client.admin.listUnitOccupants(unit.id, { headers: hdr() });
    assertEquals(list1.find((uo) => uo.id === link.id) !== undefined, true);

    // Apaga via /units/:unitId/occupants/by-occupant/:occupantId.
    const { status } = await client.admin.deleteUnitOccupantByOccupant(
      unit.id,
      occupant.id,
      { headers: hdr() },
    );
    assertEquals(status, 204);

    // Lista vazia após delete.
    const { data: list2 } = await client.admin.listUnitOccupants(unit.id, { headers: hdr() });
    assertEquals(list2.find((uo) => uo.id === link.id), undefined);
  });

  it("deleteOccupant - returns 204", async () => {
    const { status } = await client.admin.deleteOccupant(occupant.id, { headers: hdr() });
    assertEquals(status, 204);
  });

  // ── Delete occupant cascadeia para `unit_occupant` ativos (regra atómica
  // no handler API). Antes o panel orquestrava a cascade em N+1 round-trips;
  // hoje é uma transação. Razões e contexto: ver comment no handler
  // `delete.ts` do módulo occupant.
  it("deleteOccupant em cascade: link ativo é soft-deleted junto com o occupant", async () => {
    const { data: occ2 } = await client.admin.createOccupant(
      { name: "Marta", email: "marta@example.pt" } as Record<string, unknown>,
      { headers: hdr() },
    );
    const { data: link } = await client.admin.createUnitOccupant(
      unit.id,
      {
        unitId: unit.id,
        occupantId: occ2.id,
        relationshipType: "owner",
        startDate: "2026-01-01",
      } as Record<string, unknown>,
      { headers: hdr() },
    );

    // 204 - cascade transparente para o caller.
    const { status: del } = await client.admin.deleteOccupant(occ2.id, { headers: hdr() });
    assertEquals(del, 204);

    // Ocupante some das listagens.
    const { data: list } = await client.admin.listOccupants({}, { headers: hdr() });
    assertEquals(list.find((o) => o.id === occ2.id), undefined);

    const e = await assertRejects(
      () => client.admin.getOccupant(occ2.id, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);

    // Link ativo também desaparece - foi soft-deleted dentro da mesma
    // transação. `listUnitOccupants` filtra `deleted_at IS NULL`.
    const { data: uoList } = await client.admin.listUnitOccupants(unit.id, { headers: hdr() });
    assertEquals(
      uoList.find((uo) => uo.id === link.id),
      undefined,
      "link soft-deleted em cascade junto com o occupant",
    );
  });

  // ── receiveReceiptEmails: CRUD do toggle ────────────────────────────
  // Field adicionado para permitir owners de optarem por NÃO receber emails
  // dos recibos. Default `true`; toggle no portal/admin via update. O
  // re-envio (`resend_email.ts`) consulta este valor em tempo real (não o
  // snapshot do recibo) - ver teste separado em
  // `api_admin_receipt_resend_current_state_test.ts`.
  //
  // NB: criamos um ocupante NOVO para esta seção porque o `occupant`
  // global é deletado por um teste anterior ("deleteOccupant - returns 204").
  let receiptToggleOccupantId = "";

  it("setup - cria ocupante isolado para a seção do receiveReceiptEmails", async () => {
    const { data } = await client.admin.createOccupant(
      { name: "Toggle Test Owner", type: "owner", email: "toggle-test@example.pt" },
      { headers: hdr() },
    );
    receiptToggleOccupantId = data.id;
    // Confirma default no momento da criação
    assertEquals(data.receiveReceiptEmails, true);
  });

  it("getOccupant - default receiveReceiptEmails=true (sem set explícito)", async () => {
    const { data } = await client.admin.getOccupant(receiptToggleOccupantId, {
      headers: hdr(),
    });
    assertEquals(data.receiveReceiptEmails, true);
  });

  it("updateOccupant - set receiveReceiptEmails=false persiste + GET reflete", async () => {
    const upd = await client.admin.updateOccupant(
      receiptToggleOccupantId,
      { receiveReceiptEmails: false },
      { headers: hdr() },
    );
    assertEquals(upd.status, 200);
    assertEquals(upd.data.receiveReceiptEmails, false);

    // Sanity check: GET separado devolve o mesmo valor (persistido na DB,
    // não só no objeto devolvido pelo update).
    const get = await client.admin.getOccupant(receiptToggleOccupantId, { headers: hdr() });
    assertEquals(get.data.receiveReceiptEmails, false);
  });

  it("updateOccupant - omitir receiveReceiptEmails NÃO mexe no valor", async () => {
    // Garante que PATCH com outros campos (típico - mudar phone, type) não
    // cai a flag para `null` ou `true` por engano. Se este teste regredir,
    // o user fica novamente a receber emails sem o saber.
    const upd = await client.admin.updateOccupant(
      receiptToggleOccupantId,
      { phone: "+351 919000000" },
      { headers: hdr() },
    );
    assertEquals(upd.status, 200);
    assertEquals(upd.data.phone, "+351 919000000");
    assertEquals(
      upd.data.receiveReceiptEmails,
      false,
      "valor anterior tem de ser preservado quando não é enviado",
    );
  });

  it("updateOccupant - voltar a true funciona", async () => {
    const { data } = await client.admin.updateOccupant(
      receiptToggleOccupantId,
      { receiveReceiptEmails: true },
      { headers: hdr() },
    );
    assertEquals(data.receiveReceiptEmails, true);
  });

  // ── listOccupants ?ids=a,b filter ───────────────────────────────────
  // Filtro adicionado para o modal de re-envio do recibo poder pedir
  // exatamente os occupants do snapshot (ver `panel/controllers/receipts.ts
  // showPage`). Sem este filtro, o panel teria de carregar todos os
  // occupants do condomínio.

  it("listOccupants ?ids - devolve só os IDs pedidos", async () => {
    // Cria 2 occupants extra além do `occupant` (que continua ativo)
    const { data: o1 } = await client.admin.createOccupant(
      { name: "Ana Lista", type: "owner" },
      { headers: hdr() },
    );
    const { data: o2 } = await client.admin.createOccupant(
      { name: "Beto Lista", type: "owner" },
      { headers: hdr() },
    );

    // Pede só 2 IDs específicos
    const { data, status } = await client.admin.listOccupants(
      { ids: `${o1.id},${o2.id}` },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.length, 2);
    const returnedIds = data.map((o) => o.id).sort();
    assertEquals(returnedIds, [o1.id, o2.id].sort());
  });

  it("listOccupants ?ids= (vazio) - devolve [] sem ir à DB", async () => {
    const { data, status } = await client.admin.listOccupants(
      { ids: "" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data, []);
  });

  it("listOccupants ?ids=inexistente - devolve [] (sem erro)", async () => {
    const { data, status } = await client.admin.listOccupants(
      { ids: "0000000000nope" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data, []);
  });

  it("listOccupants ?ids - cross-tenant safety: IDs de outro condo não aparecem", async () => {
    // Cria condo separado + occupant para garantir isolamento
    const { data: otherCondo } = await client.super.createCondominium(
      { name: "Cross-Tenant Other Condo" },
      { headers: MASTER },
    );
    const otherHdr = { ...MASTER, "x-condominium-id": otherCondo.id };
    const { data: foreignOcc } = await client.admin.createOccupant(
      { name: "Foreign Occupant", type: "owner" },
      { headers: otherHdr },
    );

    // Pedir o ID alheio a partir do condo original - não deve devolver nada
    // (o WHERE da listOccupants força condominium_id do header).
    const { data, status } = await client.admin.listOccupants(
      { ids: foreignOcc.id },
      { headers: hdr() }, // headers do condo original
    );
    assertEquals(status, 200);
    assertEquals(
      data.length,
      0,
      "IDs de occupants de outro condo têm de ser filtrados",
    );

    // Cleanup do condo extra
    await client.super.deleteCondominium(otherCondo.id, { headers: MASTER });
  });

  it("teardown - delete unit + condominium", async () => {
    await client.super.deleteUnit(condo.id, unit.id, { headers: MASTER });
    await fx.cleanup();
  });
});
