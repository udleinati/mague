// Regressão: download do PDF de recibo pelo PORTAL.
//
// Bug: o painel fazia proxy do PDF de recibo do portal para o endpoint
// ADMIN (`/v1/admin/.../receipts/:id/pdf`), enviando o token do condómino.
// Como o occupant não tem role admin, a API devolvia 403 ("Acesso reservado
// a administradores do condomínio") - visível nos logs como pedidos a
// /v1/admin com user=<condómino>. Passou despercebido porque, testado como
// super/admin, o token TEM role admin e o proxy funcionava.
//
// Fix: endpoint portal próprio `/v1/portal/.../units/:unitId/receipts/:id/pdf`
// com scope anti-IDOR por cid+unitId (loadUnitOwnedEntity). Este teste
// encoda a INTENÇÃO: o condómino DEVE conseguir o PDF da sua fração e NÃO
// o de outra fração.
//
// Self-contained: condo + 2 units (alice owner de A1, bob owner de B1) +
// bank + charge + bank_tx + settlement + emitReceipt (gera PDF em S3).

import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAs, loginAsSuper } from "./_helpers/auth.ts";
import { seedTestUser, sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

async function rawGet(path: string, headers: Record<string, string>) {
  const resp = await fetch(`${BASE_URL}${path}`, { headers });
  const contentType = resp.headers.get("content-type") ?? "";
  const byteLength = (await resp.arrayBuffer()).byteLength;
  return { status: resp.status, contentType, byteLength };
}

describe("portal receipt PDF - download da própria fração + anti-IDOR", () => {
  let condo: Condominium;
  let unitA1: Unit;
  let unitB1: Unit;
  let aliceHeaders: { Authorization: string };
  let bobHeaders: { Authorization: string };
  let receiptId = "";

  it("setup: condo + 2 units/occupants + recibo emitido (PDF em S3)", async () => {
    const ts = Date.now();
    condo = (await client.super.createCondominium(
      { name: `Portal Receipt PDF ${ts}`, fiscalNumber: "501999888" },
      { headers: MASTER },
    )).data;
    const headers = { ...MASTER, "x-condominium-id": condo.id };

    unitA1 = (await client.super.createUnit(
      condo.id,
      { designation: "A1", permillage: 500 },
      { headers: MASTER },
    )).data;
    unitB1 = (await client.super.createUnit(
      condo.id,
      { designation: "B1", permillage: 500 },
      { headers: MASTER },
    )).data;

    const aliceEmail = `alice-rpdf-${ts}@example.pt`;
    const bobEmail = `bob-rpdf-${ts}@example.pt`;
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

    const aliceOcc = (await sqlExec(`
      INSERT INTO core.occupant (user_id,name,email,nif,condominium_id)
      VALUES ('${aliceUid}','Alice','${aliceEmail}','501999888','${condo.id}')
      RETURNING id`)).split("\n")[0].trim();
    const bobOcc = (await sqlExec(`
      INSERT INTO core.occupant (user_id,name,email,condominium_id)
      VALUES ('${bobUid}','Bob','${bobEmail}','${condo.id}')
      RETURNING id`)).split("\n")[0].trim();
    // start_date antes do settlement (2026-01-15): o recibo exige owner
    // registado à data, senão emitReceipt falha com "Sem destinatário".
    await sqlExec(`
      INSERT INTO core.unit_occupant (unit_id,occupant_id,relationship_type,start_date)
      VALUES ('${unitA1.id}','${aliceOcc}','owner','2026-01-01');
      INSERT INTO core.unit_occupant (unit_id,occupant_id,relationship_type,start_date)
      VALUES ('${unitB1.id}','${bobOcc}','owner','2026-01-01');
    `);
    aliceHeaders = await loginAs(aliceEmail, "test12345");
    bobHeaders = await loginAs(bobEmail, "test12345");

    // Charge em A1 → bank_tx → settlement → emitReceipt (gera PDF).
    const { data: ba } = await client.admin.createBankAccount(
      { bankName: "Banco RPDF", iban: "PT50000700000000000000999", kind: "bank" },
      { headers },
    );
    const { data: ch } = await client.admin.createCharge(
      {
        kind: "receivable",
        nature: "debit",
        chargeType: "quota",
        scope: "unit",
        unitId: unitA1.id,
        issueDate: "2026-01-01",
        competencePeriod: "2026-01-01",
        amountCents: 5000,
        description: "Quota Janeiro/2026",
      },
      { headers },
    );
    const { data: bt } = await client.admin.createBankTransaction(
      {
        bankAccountId: ba.id as string,
        transactionDate: "2026-01-15",
        amount: 5000,
        description: "Pagamento Quota Jan",
      },
      { headers },
    );
    await client.admin.createSettlement(
      {
        settlementType: "bank_reconciliation",
        bankTransactionId: bt.id as string,
        debitChargeId: ch.id as string,
        amount: 5000,
        settlementDate: "2026-01-15",
      },
      { headers },
    );
    const { data: r } = await client.admin.emitReceipt(
      { bankTransactionId: bt.id as string, unitId: unitA1.id },
      { headers },
    );
    receiptId = r.receiptId;
    assertExists(receiptId);
  });

  it("alice (owner A1) GET o PDF do seu recibo → 200 application/pdf", async () => {
    const r = await rawGet(
      `/v1/portal/condominiums/${condo.id}/units/${unitA1.id}/receipts/${receiptId}/pdf`,
      aliceHeaders,
    );
    assertEquals(
      r.status,
      200,
      "condómino devia conseguir o PDF do seu recibo (regressão do 403 admin)",
    );
    assertEquals(r.contentType.includes("application/pdf"), true);
    assertEquals(r.byteLength > 0, true, "PDF vazio");
  });

  it("alice GET receipt id inexistente na sua unit → 404", async () => {
    const r = await rawGet(
      `/v1/portal/condominiums/${condo.id}/units/${unitA1.id}/receipts/rec_FAKE/pdf`,
      aliceHeaders,
    );
    assertEquals(r.status, 404);
  });

  it("anti-IDOR: bob (owner B1) GET recibo de A1 via a sua unit B1 → 404", async () => {
    const r = await rawGet(
      `/v1/portal/condominiums/${condo.id}/units/${unitB1.id}/receipts/${receiptId}/pdf`,
      bobHeaders,
    );
    assertEquals(r.status, 404, "recibo de A1 não pertence a B1 - não pode ser servido a bob");
  });

  it("anti-IDOR: alice tenta o recibo via unit B1 (que não é dela) → bloqueado (403/404)", async () => {
    const r = await rawGet(
      `/v1/portal/condominiums/${condo.id}/units/${unitB1.id}/receipts/${receiptId}/pdf`,
      aliceHeaders,
    );
    assertEquals(
      r.status === 403 || r.status === 404,
      true,
      `esperava 403/404, recebeu ${r.status}`,
    );
  });

  it("cleanup", async () => {
    await client.super.deleteCondominium(condo.id, { headers: MASTER });
  });
});
