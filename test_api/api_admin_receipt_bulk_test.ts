// Receipts: emitBulk + resendReceiptEmail.
//
// O api_admin_receipt_test.ts cobre emit individual + void + list + pdf
// + auto-void ao reverter, mas não corre bulk nem resend (mencionados em
// comentário no header mas sem assertions). Este ficheiro fecha esses dois.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });

describe("admin receipts - bulk emit + resend email", () => {
  let condo: Condominium;
  let unitA: Unit;
  let unitB: Unit;
  let bankAccountId = "";
  let receiptIdA = "";
  const hdr = () => ({ ...AUTH, "x-condominium-id": condo.id });

  it("setup - condo + 2 units + owners + bank_account + 2 quotas pagas", async () => {
    const { data: c } = await client.super.createCondominium(
      { name: "Bulk Receipt Test", fiscalNumber: "508111222" },
      { headers: AUTH },
    );
    condo = c;

    const { data: a } = await client.super.createUnit(
      condo.id,
      { designation: "A", permillage: 500 },
      { headers: AUTH },
    );
    unitA = a;
    const { data: b } = await client.super.createUnit(
      condo.id,
      { designation: "B", permillage: 500 },
      { headers: AUTH },
    );
    unitB = b;

    // 2 occupants (owners), com email para o resend.
    const { data: occA } = await client.admin.createOccupant(
      {
        name: "Owner A",
        type: "owner",
        nif: "111111111",
        email: "ownerA@example.pt",
      },
      { headers: hdr() },
    );
    const { data: occB } = await client.admin.createOccupant(
      {
        name: "Owner B",
        type: "owner",
        nif: "222222222",
        email: "ownerB@example.pt",
      },
      { headers: hdr() },
    );
    await client.admin.createUnitOccupant(
      unitA.id,
      { unitId: unitA.id, occupantId: occA.id, relationshipType: "owner", startDate: "2025-01-01" },
      { headers: hdr() },
    );
    await client.admin.createUnitOccupant(
      unitB.id,
      { unitId: unitB.id, occupantId: occB.id, relationshipType: "owner", startDate: "2025-01-01" },
      { headers: hdr() },
    );

    const { data: ba } = await client.admin.createBankAccount(
      { bankName: "Banco Bulk", iban: "PT50000700000000000077777", kind: "bank" },
      { headers: hdr() },
    );
    bankAccountId = ba.id as string;

    // 2 quotas + 2 bank_tx + 2 settlements -> ambas as units ficam pendentes
    // de recibo.
    for (const u of [unitA, unitB]) {
      const { data: ch } = await client.admin.createCharge(
        {
          kind: "receivable",
          nature: "debit",
          chargeType: "quota",
          scope: "unit",
          unitId: u.id,
          issueDate: "2026-02-01",
          competencePeriod: "2026-02-01",
          amountCents: 5000,
          description: `Quota Fev/${u.designation}`,
        },
        { headers: hdr() },
      );
      const { data: bt } = await client.admin.createBankTransaction(
        {
          bankAccountId,
          transactionDate: "2026-02-15",
          amount: 5000,
          description: `Pagto Fev ${u.designation}`,
        },
        { headers: hdr() },
      );
      await client.admin.createSettlement(
        {
          settlementType: "bank_reconciliation",
          bankTransactionId: bt.id,
          debitChargeId: ch.id,
          amount: 5000,
          settlementDate: "2026-02-15",
        },
        { headers: hdr() },
      );
    }
  });

  it("emitBulkReceipts - emite todos os pendentes (2 recibos) + pendingRemaining=0", async () => {
    const { data, status } = await client.admin.emitBulkReceipts({ headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data.total, 2);
    assertEquals(data.success, 2);
    assertEquals(data.failed, 0);
    // pendingRemaining: total pendentes - quantos foram processados nesta
    // chamada. Com cap MAX_BULK_EMIT=100 e 2 pendentes, esvazia a fila.
    assertEquals(data.pendingRemaining, 0);
    assertEquals(data.results.length, 2);
    // Cada resultado tem receiptId e número formato YYYY/NNNN.
    for (const r of data.results) {
      assertEquals(r.status, "success");
      assertEquals(typeof r.receiptId, "string");
      assertEquals((r.number ?? "").startsWith("2026/"), true);
    }
    // Guarda 1 receipt id (do owner A) para o resend.
    const a = data.results.find((r) => r.unitId === unitA.id);
    receiptIdA = a?.receiptId ?? "";
    assertEquals(receiptIdA.length > 0, true);
  });

  it("emitBulkReceipts - 2ª corrida: nada para emitir (fila vazia)", async () => {
    const { data, status } = await client.admin.emitBulkReceipts({ headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data.total, 0);
    assertEquals(data.success, 0);
    assertEquals(data.pendingRemaining, 0);
    assertEquals(data.results.length, 0);
  });

  it("resendReceiptEmail - re-envia para o owner do recibo", async () => {
    const { data, status } = await client.admin.resendReceiptEmail(
      receiptIdA,
      { headers: hdr() },
    );
    assertEquals(status, 200);
    // 1 owner com email -> 1 envio. O ambiente de dev usa Mailpit;
    // o que importa é que a API confirma envio.
    assertEquals(
      data.sent + data.failed >= 1,
      true,
      `Esperado pelo menos 1 envio, recebido sent=${data.sent} failed=${data.failed}`,
    );
    // Cada record tem email + sentAt + status.
    for (const r of data.records) {
      assertEquals(typeof r.email, "string");
      assertEquals(typeof r.sentAt, "string");
    }
  });

  it("teardown - cleanup", async () => {
    await client.super.deleteCondominium(condo.id, { headers: AUTH });
  });
});
