// E2E para o módulo de recibos:
//   - listPendingReceipts: fila de pendentes via vw_pending_receipts
//   - emitReceipt (POST /receipts): emit single → snapshots + número + S3 + email
//   - emitBulkReceipts: processar todos pendentes
//   - voidReceipt: anulação com justificação
//   - listReceipts: filtros (year, voided, unitId)
//   - serveReceiptPdf: GET /pdf devolve bytes válidos
//   - resendReceiptEmail: re-envia
//   - Erros: sem owner registado → bloqueia; tentar emitir 2× mesma tupla → falha
//
// Self-contained: cria condomínio + unit + occupant (owner) + bank_account
// + charge + bank_tx + settlement. Não depende do seed.

import { assertEquals, assertNotEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });

describe("admin receipts - emit/void/list/pdf", () => {
  let condo: Condominium;
  let unit: Unit;
  let occupantId = "";
  let bankAccountId = "";
  let chargeId = "";
  let bankTxId = "";
  let receiptId = "";
  let receiptNumber = "";
  let headers: Record<string, string>;

  it("setup - condominium + unit + owner + bank_account + charge + bank_tx", async () => {
    // Condomínio
    const { data: c } = await client.super.createCondominium(
      { name: "Receipt E2E Condo", fiscalNumber: "501234567" },
      { headers: AUTH },
    );
    condo = c;
    headers = { ...AUTH, "x-condominium-id": condo.id };

    // Unit
    const { data: u } = await client.super.createUnit(
      condo.id,
      { designation: "A", permillage: 1000 },
      { headers: AUTH },
    );
    unit = u;

    // Occupant (owner) com NIF para que recibo se emita ok
    const { data: occ } = await client.admin.createOccupant(
      {
        name: "João Receipt Test",
        type: "owner",
        nif: "123456789",
        email: "joao.receipt@example.pt",
      },
      { headers },
    );
    occupantId = occ.id as string;

    // Linkar como owner ativo desde data antiga (o owner tem que estar ativo
    // na data do payment).
    // Schema do validador exige `unitId` no body também (além do path).
    await client.admin.createUnitOccupant(
      u.id,
      {
        unitId: u.id,
        occupantId,
        relationshipType: "owner",
        startDate: "2025-01-01",
      },
      { headers },
    );

    // Residente na mesma fração - desde a extensão owner+resident, também
    // entra nos recipients do recibo (tenant continuaria de fora).
    const { data: resOcc } = await client.admin.createOccupant(
      {
        name: "Maria Resident Test",
        email: "maria.resident@example.pt",
      },
      { headers },
    );
    await client.admin.createUnitOccupant(
      u.id,
      {
        unitId: u.id,
        occupantId: resOcc.id as string,
        relationshipType: "resident",
        startDate: "2025-01-01",
      },
      { headers },
    );

    // Bank account
    const { data: ba } = await client.admin.createBankAccount(
      {
        bankName: "Banco Receipts E2E",
        iban: "PT50000700000000000000000",
        kind: "bank",
      },
      { headers },
    );
    bankAccountId = ba.id as string;

    // Charge receivable (quota). competencePeriod tem que ser YYYY-MM-01
    // (1º dia do mês - validador é estricto). amountCents é nome do campo.
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
    chargeId = ch.id as string;

    // Bank tx que liquida a quota
    const { data: bt } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2026-01-15",
        amount: 5000,
        description: "Pagamento Quota Jan",
      },
      { headers },
    );
    bankTxId = bt.id as string;

    // Settlement bank_reconciliation contra a quota
    await client.admin.createSettlement(
      {
        settlementType: "bank_reconciliation",
        bankTransactionId: bt.id,
        debitChargeId: chargeId,
        amount: 5000,
        settlementDate: "2026-01-15",
      },
      { headers },
    );
  });

  it("listPendingReceipts - inclui a tupla criada", async () => {
    const { data, status } = await client.admin.listPendingReceipts({ headers });
    assertEquals(status, 200);
    const found = data.find((p) => p.bankTransactionId === bankTxId && p.unitId === unit.id);
    assertNotEquals(found, undefined, "tupla deve estar pendente");
    assertEquals(found?.recipientAmount, 5000);
  });

  it("emitReceipt - happy path: cria recibo + snapshots + número", async () => {
    const { data, status } = await client.admin.emitReceipt(
      { bankTransactionId: bankTxId, unitId: unit.id },
      { headers },
    );
    assertEquals(status, 201);
    assertNotEquals(data.receiptId, undefined);
    assertNotEquals(data.number, undefined);
    assertEquals(data.amountCents, 5000);
    receiptId = data.receiptId;
    receiptNumber = data.number;

    // Numeração: deve começar em {ano}/00001 (primeiro recibo deste condo).
    assertEquals(receiptNumber, "2026/00001");
  });

  it("listPendingReceipts - tupla saiu da fila após emissão", async () => {
    const { data } = await client.admin.listPendingReceipts({ headers });
    const found = data.find((p) => p.bankTransactionId === bankTxId && p.unitId === unit.id);
    assertEquals(found, undefined, "tupla emitida não deve aparecer mais");
  });

  it("emitReceipt - tentar emitir 2ª vez mesma tupla → falha", async () => {
    let errored = false;
    try {
      await client.admin.emitReceipt(
        { bankTransactionId: bankTxId, unitId: unit.id },
        { headers },
      );
    } catch (e) {
      errored = true;
      // Idealmente é EMIT_FAILED com mensagem sobre não estar elegível
      const err = e as { data?: { error?: { code?: string } } };
      assertEquals(err.data?.error?.code, "EMIT_FAILED");
    }
    assertEquals(errored, true, "emit duplicado deveria falhar");
  });

  it("getReceipt - inclui snapshots imutáveis + pdfUrl", async () => {
    const { data, status } = await client.admin.getReceipt(receiptId, { headers });
    assertEquals(status, 200);
    assertEquals(data.number, receiptNumber);
    assertEquals(data.amountCents, 5000);
    assertEquals(data.isVoided, false);

    // Snapshot do condomínio: name correcto
    const condoSnap = data.condominiumSnapshot as { name: string };
    assertEquals(condoSnap.name, "Receipt E2E Condo");

    // Snapshot dos recipients: owner + resident, ambos ativos à data do
    // pagamento. O recibo vai aos dois (não só ao owner).
    const recipients = data.recipientsSnapshot as Array<{ nif: string; name: string }>;
    assertEquals(recipients.length, 2);
    const names = recipients.map((r) => r.name).sort();
    assertEquals(names, ["João Receipt Test", "Maria Resident Test"]);
    const owner = recipients.find((r) => r.name === "João Receipt Test");
    assertEquals(owner?.nif, "123456789");

    // Lines: 1 line com a quota
    const lines = data.linesSnapshot as Array<{ description: string; amount: number }>;
    assertEquals(lines.length, 1);
    assertEquals(lines[0].amount, 5000);

    // pdfUrl populada (presigned URL S3)
    assertNotEquals(data.pdfUrl, null, "pdfUrl deve estar populada");
  });

  it("GET /receipts/:id/pdf - serve bytes válidos (header %PDF)", async () => {
    const res = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${condo.id}/receipts/${receiptId}/pdf`,
      { headers },
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "application/pdf");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Header PDF: bytes 0-3 = %PDF
    const header = String.fromCharCode(...bytes.slice(0, 4));
    assertEquals(header, "%PDF");
    // Tamanho razoável (>5KB)
    assertEquals(bytes.byteLength > 5000, true);
  });

  it("listReceipts - filtros year + voided + unitId", async () => {
    // Sem filtro: 1 recibo
    const all = await client.admin.listReceipts({}, { headers });
    assertEquals(all.data.length, 1);

    // Filtrar year=2026: 1 recibo
    const y2026 = await client.admin.listReceipts({ year: "2026" }, { headers });
    assertEquals(y2026.data.length, 1);

    // Filtrar year=2025: 0
    const y2025 = await client.admin.listReceipts({ year: "2025" }, { headers });
    assertEquals(y2025.data.length, 0);

    // Filtrar voided=false: 1
    const notVoid = await client.admin.listReceipts({ voided: "false" }, { headers });
    assertEquals(notVoid.data.length, 1);

    // Filtrar voided=true: 0 (ainda não anulado)
    const voided = await client.admin.listReceipts({ voided: "true" }, { headers });
    assertEquals(voided.data.length, 0);

    // Filtrar unitId desta unit: 1
    const byUnit = await client.admin.listReceipts({ unitId: unit.id }, { headers });
    assertEquals(byUnit.data.length, 1);
  });

  it("voidReceipt - anula com justificação + audit voidedBy", async () => {
    const { data, status } = await client.admin.voidReceipt(
      receiptId,
      { reason: "Teste API - pagamento foi de outra fração" },
      { headers },
    );
    assertEquals(status, 200);
    assertNotEquals(data.voidedAt, null);
    assertEquals(data.voidedReason, "Teste API - pagamento foi de outra fração");
    assertNotEquals(data.voidedBy, null);
    assertEquals(data.isVoided, true);
  });

  it("voidReceipt - anular 2ª vez → 409 ALREADY_VOIDED", async () => {
    let errored = false;
    try {
      await client.admin.voidReceipt(
        receiptId,
        { reason: "double void" },
        { headers },
      );
    } catch (e) {
      errored = true;
      const err = e as { statusCode?: number; data?: { error?: { code?: string } } };
      assertEquals(err.statusCode, 409);
      assertEquals(err.data?.error?.code, "ALREADY_VOIDED");
    }
    assertEquals(errored, true);
  });

  it("listReceipts voided=true - agora inclui o recibo anulado", async () => {
    const voided = await client.admin.listReceipts({ voided: "true" }, { headers });
    assertEquals(voided.data.length, 1);
  });
});
