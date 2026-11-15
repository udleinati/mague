// E2E para o endpoint POST /v1/admin/condominiums/:cid/receipts/:rid/access:
//
//   1. 1º access regista entry no `recipients_access` (write-once por occupant).
//   2. 2º access com o mesmo occupantId é no-op idempotente (`tracked: false,
//      reason: "already_recorded"`) e o `firstDownloadedAt` original é
//      preservado.
//   3. Anti-IDOR: chamar com occupantId que NÃO está em `recipients_snapshot`
//      devolve 403 NOT_RECIPIENT.
//   4. occupantId em falta no body → 400 VALIDATION_ERROR.
//   5. receiptId inexistente → 404 NOT_FOUND.
//
// Self-contained: cria condo + unit + 2 occupants + bank_account + charge +
// bank_tx + settlement + receipt. Reaproveita o fluxo de
// `api_admin_receipt_test.ts` mas isolado num condo separado para não colidir
// com a numeração de recibos (cada condo arranca em {ano}/00001).

import { assertEquals, assertNotEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client, type Condominium } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });

interface AccessRecord {
  occupantId: string;
  firstDownloadedAt: string;
  occupantName: string;
}

describe("admin receipts - track access (recipients_access)", () => {
  let condo: Condominium;
  let recipientOccupantId = ""; // owner - está no recipients_snapshot
  let strangerOccupantId = ""; // outro condo / outra unit - NÃO é recipient
  let receiptId = "";
  let headers: Record<string, string>;

  it("setup - condo + unit + 2 occupants + bank + charge + bank_tx + settlement + receipt", async () => {
    const { data: c } = await client.super.createCondominium(
      { name: "Receipt Access E2E Condo", fiscalNumber: "501555444" },
      { headers: AUTH },
    );
    condo = c;
    headers = { ...AUTH, "x-condominium-id": condo.id };

    const { data: u } = await client.super.createUnit(
      condo.id,
      { designation: "A", permillage: 1000 },
      { headers: AUTH },
    );

    // Owner com NIF - vai aparecer em recipients_snapshot do recibo.
    const { data: ownerOcc } = await client.admin.createOccupant(
      {
        name: "Owner Recipient",
        type: "owner",
        nif: "501555444",
        email: "owner-rec@test.pt",
      },
      { headers },
    );
    recipientOccupantId = ownerOcc.id as string;

    await client.admin.createUnitOccupant(
      u.id,
      {
        unitId: u.id,
        occupantId: recipientOccupantId,
        relationshipType: "owner",
        startDate: "2026-01-01",
      },
      { headers },
    );

    // Stranger occupant - não ligado à unit do recibo. Vai ficar fora do
    // recipients_snapshot e portanto será rejeitado pelo anti-IDOR.
    const { data: stranger } = await client.admin.createOccupant(
      {
        name: "Stranger NotRecipient",
        type: "tenant",
        email: "stranger@test.pt",
      },
      { headers },
    );
    strangerOccupantId = stranger.id as string;

    // Bank account
    const { data: ba } = await client.admin.createBankAccount(
      {
        bankName: "Banco Receipt Access",
        iban: "PT50000700000000000000000",
        kind: "bank",
      },
      { headers },
    );

    // Charge + bank_tx + settlement (igual ao receipt_test base).
    const { data: ch } = await client.admin.createCharge(
      {
        kind: "receivable",
        nature: "debit",
        chargeType: "quota",
        scope: "unit",
        unitId: u.id,
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
      { bankTransactionId: bt.id as string, unitId: u.id },
      { headers },
    );
    receiptId = r.receiptId;
  });

  it("recibo recém-emitido tem recipientsAccess = []", async () => {
    const { data } = await client.admin.getReceipt(receiptId, { headers });
    const access = data.recipientsAccess as AccessRecord[];
    assertEquals(Array.isArray(access), true);
    assertEquals(access.length, 0);
  });

  it("trackReceiptAccess 1ª vez - cria entry com firstDownloadedAt + occupantName", async () => {
    const { data, status } = await client.admin.trackReceiptAccess(
      receiptId,
      { occupantId: recipientOccupantId },
      { headers },
    );
    assertEquals(status, 201);
    assertEquals(data.tracked, true);
    assertNotEquals(data.record, undefined);
    assertEquals(data.record?.occupantId, recipientOccupantId);
    assertEquals(data.record?.occupantName, "Owner Recipient");
    // firstDownloadedAt é ISO string
    assertEquals(typeof data.record?.firstDownloadedAt, "string");

    // Verifica que ficou na DB via getReceipt
    const { data: rec } = await client.admin.getReceipt(receiptId, { headers });
    const access = rec.recipientsAccess as AccessRecord[];
    assertEquals(access.length, 1);
    assertEquals(access[0].occupantId, recipientOccupantId);
  });

  it("trackReceiptAccess 2ª vez (mesmo occupant) - no-op idempotente", async () => {
    // Captura o firstDownloadedAt antes.
    const { data: rec1 } = await client.admin.getReceipt(receiptId, { headers });
    const before = (rec1.recipientsAccess as AccessRecord[])[0];
    const originalTimestamp = before.firstDownloadedAt;

    // Pequena pausa para garantir que se houvesse overwrite, o timestamp
    // mudaria (test seria útil só se passasse sem overwrite).
    await new Promise((r) => setTimeout(r, 30));

    const { data, status } = await client.admin.trackReceiptAccess(
      receiptId,
      { occupantId: recipientOccupantId },
      { headers },
    );
    // Endpoint devolve 200 (não 201) com tracked=false na 2ª chamada.
    assertEquals(status, 200);
    assertEquals(data.tracked, false);
    assertEquals(data.reason, "already_recorded");

    // Array continua com 1 entry e timestamp inalterado.
    const { data: rec2 } = await client.admin.getReceipt(receiptId, { headers });
    const access = rec2.recipientsAccess as AccessRecord[];
    assertEquals(access.length, 1);
    assertEquals(access[0].firstDownloadedAt, originalTimestamp);
  });

  it("anti-IDOR: occupant que NÃO é recipient → 403 NOT_RECIPIENT", async () => {
    let errored = false;
    try {
      await client.admin.trackReceiptAccess(
        receiptId,
        { occupantId: strangerOccupantId },
        { headers },
      );
    } catch (e) {
      errored = true;
      const err = e as ApiError;
      const errBody = err.data as { error?: { code?: string } } | undefined;
      assertEquals(err.statusCode, 403);
      assertEquals(errBody?.error?.code, "NOT_RECIPIENT");
    }
    assertEquals(errored, true, "stranger não deveria conseguir track");

    // E o array continua sem entry para stranger.
    const { data: rec } = await client.admin.getReceipt(receiptId, { headers });
    const access = rec.recipientsAccess as AccessRecord[];
    assertEquals(access.length, 1);
    assertEquals(access[0].occupantId, recipientOccupantId);
  });

  it("body sem occupantId → 400 VALIDATION_ERROR", async () => {
    let errored = false;
    try {
      await client.admin.trackReceiptAccess(
        receiptId,
        { occupantId: "" },
        { headers },
      );
    } catch (e) {
      errored = true;
      const err = e as ApiError;
      const errBody = err.data as { error?: { code?: string } } | undefined;
      assertEquals(err.statusCode, 400);
      assertEquals(errBody?.error?.code, "VALIDATION_ERROR");
    }
    assertEquals(errored, true);
  });

  it("receiptId inexistente → 404", async () => {
    let errored = false;
    try {
      await client.admin.trackReceiptAccess(
        "rec_does_not_exist_xyz",
        { occupantId: recipientOccupantId },
        { headers },
      );
    } catch (e) {
      errored = true;
      const err = e as ApiError;
      assertEquals(err.statusCode, 404);
    }
    assertEquals(errored, true);
  });

  it("cleanup - apaga o condo de teste", async () => {
    await client.super.deleteCondominium(condo.id, { headers: AUTH });
  });
});
