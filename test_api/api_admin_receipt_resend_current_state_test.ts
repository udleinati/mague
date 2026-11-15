// Anti-regressão: re-envio de recibo respeita o estado ACTUAL de
// `occupant.receive_receipt_emails`, não o snapshot congelado no momento
// da emissão.
//
// O risco: iterar `receipt.recipientsSnapshot[].receiveEmails`. Se um owner tinha
// o opt-in desligado quando o recibo foi emitido e depois o religa, o re-envio
// saltava-o sem qualquer erro visível. `modules/admin/receipt/resend_email.ts`
// consulta `core.occupant.receive_receipt_emails` em tempo real para cada
// `occupantId` do snapshot.
//
// Cobertura aqui (3 cenários):
//   1. Snapshot=false + atual=true → ENVIA (o caso do bug).
//   2. Snapshot=true + atual=false → SALTA (inverso, opt-out posterior).
//   3. Occupant eliminado → SALTA (não rebenta).
//
// Estratégia: criamos condomínio + unit + 2 owners. Owner A com flag
// inicial true; Owner B com false. Emitimos recibo (snapshot congelado).
// Invertem-se as flags. Re-envio deve mandar a B (não A).

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });

describe("admin receipt resend - estado atual vs snapshot do receive_receipt_emails", () => {
  let condo: Condominium;
  let unit: Unit;
  let receiptId = "";
  let ownerAId = "";
  let ownerBId = "";
  let headers: Record<string, string>;

  it("setup - condo + unit + 2 owners (A:true, B:false) + recibo emitido", async () => {
    const ts = Date.now();
    const { data: c } = await client.super.createCondominium(
      { name: `Resend Current State ${ts}`, fiscalNumber: "510000001" },
      { headers: AUTH },
    );
    condo = c;
    headers = { ...AUTH, "x-condominium-id": condo.id };

    const { data: u } = await client.super.createUnit(
      condo.id,
      { designation: "A", permillage: 1000 },
      { headers: AUTH },
    );
    unit = u;

    // Owner A - começa com receiveReceiptEmails=true (default).
    const { data: occA } = await client.admin.createOccupant(
      {
        name: "Owner A (true→false)",
        type: "owner",
        nif: "510000001",
        email: `owner-a-${ts}@example.pt`,
      },
      { headers },
    );
    ownerAId = occA.id;
    // Confirma default
    assertEquals(occA.receiveReceiptEmails, true);

    // Owner B - desligamos a flag ANTES de emitir (vai para snapshot=false).
    const { data: occB } = await client.admin.createOccupant(
      {
        name: "Owner B (false→true)",
        type: "owner",
        nif: "510000002",
        email: `owner-b-${ts}@example.pt`,
      },
      { headers },
    );
    ownerBId = occB.id;
    await client.admin.updateOccupant(
      ownerBId,
      { receiveReceiptEmails: false },
      { headers },
    );

    // Link ambos como owners da unit
    await client.admin.createUnitOccupant(
      unit.id,
      {
        unitId: unit.id,
        occupantId: ownerAId,
        relationshipType: "owner",
        startDate: "2025-01-01",
      },
      { headers },
    );
    await client.admin.createUnitOccupant(
      unit.id,
      {
        unitId: unit.id,
        occupantId: ownerBId,
        relationshipType: "owner",
        startDate: "2025-01-01",
      },
      { headers },
    );

    // Bank account + charge + bank_tx + settlement → emitir recibo
    const { data: ba } = await client.admin.createBankAccount(
      { bankName: "Banco RCS", iban: "PT50000700000000000099999", kind: "bank" },
      { headers },
    );
    const { data: ch } = await client.admin.createCharge(
      {
        kind: "receivable",
        nature: "debit",
        chargeType: "quota",
        scope: "unit",
        unitId: unit.id,
        issueDate: "2026-03-01",
        competencePeriod: "2026-03-01",
        amountCents: 5000,
        description: "Quota Mar/A",
      },
      { headers },
    );
    const { data: bt } = await client.admin.createBankTransaction(
      {
        bankAccountId: ba.id as string,
        transactionDate: "2026-03-15",
        amount: 5000,
        description: "Pagto Mar A",
      },
      { headers },
    );
    await client.admin.createSettlement(
      {
        settlementType: "bank_reconciliation",
        bankTransactionId: bt.id as string,
        debitChargeId: ch.id as string,
        amount: 5000,
        settlementDate: "2026-03-15",
      },
      { headers },
    );
    const { data: emit } = await client.admin.emitReceipt(
      { bankTransactionId: bt.id as string, unitId: unit.id },
      { headers },
    );
    receiptId = emit.receiptId;
  });

  it("snapshot capturado: A=true, B=false (verdade no momento da emissão)", async () => {
    // Sanity check - o snapshot do recibo congelou o estado correcto.
    // Sem este assert, os testes seguintes não testariam o que pensamos.
    const { data: rcp } = await client.admin.getReceipt(receiptId, { headers });
    const recipients = rcp.recipientsSnapshot as Array<{
      occupantId: string;
      receiveEmails: boolean;
    }>;
    const snapA = recipients.find((r) => r.occupantId === ownerAId);
    const snapB = recipients.find((r) => r.occupantId === ownerBId);
    assertEquals(snapA?.receiveEmails, true, "A devia estar true no snapshot");
    assertEquals(snapB?.receiveEmails, false, "B devia estar false no snapshot");
  });

  it("resend respeita estado atual - inverte flags e re-envia", async () => {
    // Inverte as preferências DEPOIS da emissão. Snapshot continua A=true/B=false
    // mas o estado atual passa a A=false/B=true.
    await client.admin.updateOccupant(
      ownerAId,
      { receiveReceiptEmails: false },
      { headers },
    );
    await client.admin.updateOccupant(
      ownerBId,
      { receiveReceiptEmails: true },
      { headers },
    );

    // Re-envia - deve mandar APENAS a B (estado atual), não a A.
    const { data, status } = await client.admin.resendReceiptEmail(receiptId, {
      headers,
    });
    assertEquals(status, 200);
    assertEquals(data.sent, 1, "exatamente 1 email enviado (B)");
    assertEquals(data.failed, 0, "0 falhas");

    // O record de envio diz que foi a B.
    const sentRecord = data.records.find((r) => r.status === "sent");
    assertEquals(
      sentRecord?.email.startsWith("owner-b-"),
      true,
      "o envio foi para owner B (estado atual=true), não A",
    );
  });

  it("resend salta occupant eliminado (não rebenta)", async () => {
    // Cenário: owner B foi eliminado entre a emissão e o re-envio. Snapshot
    // ainda contém B (audit) mas a query do estado atual não devolve nada
    // para esse ID - o re-envio salta sem erro.
    //
    // Antes: precisávamos que pelo menos um recipient continuasse válido.
    // Para isto, primeiro religamos A.
    await client.admin.updateOccupant(
      ownerAId,
      { receiveReceiptEmails: true },
      { headers },
    );
    // Agora apagamos B
    await client.admin.deleteOccupant(ownerBId, { headers });

    // Re-envio - deve mandar a A; B (eliminado) é silenciosamente saltado.
    const { data, status } = await client.admin.resendReceiptEmail(receiptId, {
      headers,
    });
    assertEquals(status, 200);
    assertEquals(data.sent, 1, "1 enviado (A re-habilitado)");
    assertEquals(data.failed, 0, "B eliminado → skipped, não failed");
    const sentRecord = data.records.find((r) => r.status === "sent");
    assertEquals(sentRecord?.email.startsWith("owner-a-"), true);
  });

  it("teardown - delete condominium", async () => {
    await client.super.deleteCondominium(condo.id, { headers: AUTH });
  });
});
