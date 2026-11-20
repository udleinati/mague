// Devolução de fornecedor: entrada bancária que abate uma despesa anterior.
// Cenário canónico (ver docs/flows/02-fluxo-despesas.md "Nota de crédito do
// fornecedor"): admin pagou €200 a fornecedor, este devolve €50 por excesso.
// Em vez de criar charge receivable (apareceria como receita nova) ou um
// charge_offset (a debit original já está open=0), o endpoint dedicado cria
// charge payable+credit + settlement bank_reconciliation com creditChargeId
// num atom transacional.
//
// Cobertura:
//   • Happy path com sourceChargeId (link para despesa original via source_id)
//   • Happy path sem sourceChargeId (refund autónomo, source_id null)
//   • WRONG_SIGN: bank_tx negativa
//   • WRONG_STATUS: bank_tx já reconciled
//   • bank_tx revertida aceita nova devolução
//   • supplier mismatch: sourceChargeId de outro fornecedor
//   • amount excede |bank_tx|

import { assertEquals, assertGreater } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });

describe("admin refund_supplier - devolução de fornecedor via bank_reconciliation", () => {
  let fx: ScenarioFixture;
  let _unit: Unit;
  let bankAccountId = "";
  let supplierA = "";
  let supplierB = "";

  it("setup - condo + unit + bank_account + 2 suppliers", async () => {
    fx = await seedScenario(client, AUTH)
      .withCondo("Refund Supplier Test")
      .withUnit({ designation: "A", permillage: 1000 })
      .build();
    _unit = fx.units[0];
    const headers = fx.hdr();

    const { data: ba } = await client.admin.createBankAccount(
      {
        bankName: "Banco Refund",
        iban: "PT50000700000000000000222",
        accountName: "Refund Test",
        openingBalance: 0,
        openingBalanceDate: "2099-01-01",
      },
      { headers },
    );
    bankAccountId = ba.id as string;

    const { data: sA } = await client.admin.createSupplier(
      { name: "Obrafix Refund" },
      { headers },
    );
    supplierA = sA.id as string;

    const { data: sB } = await client.admin.createSupplier(
      { name: "Outro Fornecedor" },
      { headers },
    );
    supplierB = sB.id as string;
  });

  // ─── Cenário 1: happy path com sourceChargeId ───────────────────────────
  let originalChargeId = "";
  let inflowTxId = "";

  it("happy path - paga 200, recebe refund 50 e regista via /refund_supplier", async () => {
    const headers = fx.hdr();

    // 1. Cria fatura supplier_service de 200€.
    const { data: chg } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "supplier_service",
        description: "Pesquisa Infiltração",
        issueDate: "2099-04-01",
        dueDate: "2099-04-30",
        competencePeriod: "2099-04-01",
        amountCents: 20000,
        supplierId: supplierA,
      },
      { headers },
    );
    originalChargeId = chg.id as string;

    // 2. bank_tx -200 (pagamento) + concilia.
    const { data: outflowTx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2099-04-15",
        amount: -20000,
        description: "Pagto Obrafix Refund",
      },
      { headers },
    );
    const allocResp = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/bank_transactions/${outflowTx.id}/allocate_to_supplier`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId: supplierA }),
      },
    );
    assertEquals(allocResp.status, 201);
    await allocResp.body?.cancel();

    // 3. bank_tx +50 (refund) ainda unreconciled.
    const { data: inflowTx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2099-04-28",
        amount: 5000,
        description: "TRF DE OBRAFIX - Devolução excesso",
      },
      { headers },
    );
    inflowTxId = inflowTx.id as string;

    // 4. POST /refund_supplier com sourceChargeId.
    const refundResp = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/bank_transactions/${inflowTxId}/refund_supplier`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierId: supplierA,
          sourceChargeId: originalChargeId,
          amount: 5000,
        }),
      },
    );
    assertEquals(refundResp.status, 201);
    const refundBody = await refundResp.json() as {
      data: { chargeId: string; settlementId: string; bankTransactionStatus: string };
    };
    assertEquals(refundBody.data.bankTransactionStatus, "reconciled");
    assertGreater(refundBody.data.chargeId.length, 0);
    assertGreater(refundBody.data.settlementId.length, 0);

    // 5. Verifica a nova charge: kind=payable, nature=credit, source_id=original.
    const { data: refundCharge } = await client.admin.getCharge(refundBody.data.chargeId, {
      headers,
    });
    const c = refundCharge as unknown as {
      kind: string;
      nature: string;
      supplierId: string;
      originalAmount: number;
      openAmount: number;
      status: string;
      sourceType: string | null;
      sourceId: string | null;
    };
    assertEquals(c.kind, "payable");
    assertEquals(c.nature, "credit");
    assertEquals(c.supplierId, supplierA);
    assertEquals(c.originalAmount, 5000);
    assertEquals(c.openAmount, 0); // settled em full pelo bank_tx +50.
    assertEquals(c.status, "paid");
    assertEquals(c.sourceType, "supplier_refund");
    assertEquals(c.sourceId, originalChargeId);
  });

  // ─── Cenário 2: refund sem sourceChargeId ───────────────────────────────
  it("happy path sem sourceChargeId - cria charge com source_id null", async () => {
    const headers = fx.hdr();

    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2099-05-01",
        amount: 3000,
        description: "TRF de fornecedor X",
      },
      { headers },
    );

    const refundResp = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/bank_transactions/${tx.id}/refund_supplier`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierId: supplierA,
          amount: 3000,
          description: "Devolução adiantamento",
        }),
      },
    );
    assertEquals(refundResp.status, 201);
    const body = await refundResp.json() as {
      data: { chargeId: string };
    };
    const { data: chg } = await client.admin.getCharge(body.data.chargeId, { headers });
    const c = chg as unknown as {
      sourceType: string | null;
      sourceId: string | null;
      description: string;
    };
    assertEquals(c.sourceType, null);
    assertEquals(c.sourceId, null);
    assertEquals(c.description, "Devolução adiantamento");
  });

  // ─── Cenário 3: WRONG_SIGN (tx negativa) ─────────────────────────────────
  it("rejeita refund em bank_tx negativa (saída)", async () => {
    const headers = fx.hdr();

    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2099-05-02",
        amount: -1000,
        description: "Saída teste",
      },
      { headers },
    );

    const resp = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/bank_transactions/${tx.id}/refund_supplier`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId: supplierA, amount: 1000 }),
      },
    );
    assertEquals(resp.status, 400);
    const body = await resp.json() as { error: { code: string } };
    assertEquals(body.error.code, "WRONG_SIGN");
  });

  // ─── Cenário 4: WRONG_STATUS (tx já reconciled) ──────────────────────────
  it("rejeita refund em bank_tx já reconciled", async () => {
    const headers = fx.hdr();

    const resp = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/bank_transactions/${inflowTxId}/refund_supplier`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId: supplierA, amount: 1000 }),
      },
    );
    assertEquals(resp.status, 409);
    const body = await resp.json() as { error: { code: string } };
    assertEquals(body.error.code, "WRONG_STATUS");
  });

  // ─── Cenário 4b: bank_tx revertida aceita nova devolução ─────────────────
  it("devolução revertida por engano regista-se de novo no mesmo movimento", async () => {
    const headers = fx.hdr();
    const base =
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/bank_transactions/${inflowTxId}`;

    const reverseResp = await fetch(`${base}/reverse`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Devolução registada no fornecedor errado" }),
    });
    assertEquals(reverseResp.status, 200);
    await reverseResp.body?.cancel();

    // Sem settlements ativos o movimento está livre: o separador Devolução tem de o aceitar,
    // como a conciliação manual e a imputação.
    const resp = await fetch(`${base}/refund_supplier`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        supplierId: supplierA,
        sourceChargeId: originalChargeId,
        amount: 5000,
      }),
    });
    assertEquals(resp.status, 201);
    const body = await resp.json() as {
      data: { chargeId: string; bankTransactionStatus: string };
    };
    assertEquals(body.data.bankTransactionStatus, "reconciled");
    const { data: chg } = await client.admin.getCharge(body.data.chargeId, { headers });
    assertEquals((chg as unknown as { status: string }).status, "paid");
  });

  // ─── Cenário 5: supplier mismatch ────────────────────────────────────────
  it("rejeita refund quando sourceChargeId é de outro fornecedor", async () => {
    const headers = fx.hdr();

    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2099-05-03",
        amount: 1500,
        description: "Refund mismatch",
      },
      { headers },
    );

    const resp = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/bank_transactions/${tx.id}/refund_supplier`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierId: supplierB,
          sourceChargeId: originalChargeId, // pertence a supplierA
          amount: 1500,
        }),
      },
    );
    assertEquals(resp.status, 400);
    const body = await resp.json() as { error: { code: string; message: string } };
    assertEquals(body.error.code, "VALIDATION_ERROR");
  });

  // ─── Cenário 6: amount > |bank_tx| ───────────────────────────────────────
  it("rejeita refund com amount > saldo não-alocado da bank_tx", async () => {
    const headers = fx.hdr();

    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2099-05-04",
        amount: 2000,
        description: "Tx pequena",
      },
      { headers },
    );

    const resp = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/bank_transactions/${tx.id}/refund_supplier`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId: supplierA, amount: 5000 }),
      },
    );
    assertEquals(resp.status, 400);
    const body = await resp.json() as { error: { code: string } };
    assertEquals(body.error.code, "VALIDATION_ERROR");
  });

  it("teardown - cleanup", async () => {
    await fx.cleanup();
  });
});
