// Fluxos de conciliação que o painel pode disparar via API e que não têm
// cobertura noutros testes API:
//
//   1. Reverter bank_tx NEGATIVA (saída a fornecedor): valida o caminho
//      v_btx_sign < 0 do fn_settlement_au, que o pgTAP cobre ao nível
//      DB mas que aqui faz pelo endpoint POST /reverse (Zod, autorização,
//      cascade).
//   2. Re-conciliar uma bank_tx revertida: gestor reverteu por engano,
//      clica "conciliar" na UI -> POST /allocate_to_unit numa tx em
//      status 'reversed'. Este teste garante que o caminho UI funciona.
//   3. Ignore + Unignore: fluxo do painel sem cobertura. Marcar como
//      'ignored' (transferências internas) e voltar a 'unreconciled'.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });

describe("admin reconciliation - reverse negative + re-allocate + ignore", () => {
  let fx: ScenarioFixture;
  let unit: Unit;
  let bankAccountId = "";
  let supplierId = "";

  it("setup - condo + unit + bank_account + supplier", async () => {
    fx = await seedScenario(client, AUTH)
      .withCondo("Reconciliation Flows Test")
      .withUnit({ designation: "A", permillage: 1000 })
      .build();
    unit = fx.units[0];
    const headers = fx.hdr();

    const { data: ba } = await client.admin.createBankAccount(
      {
        bankName: "Banco Flow",
        iban: "PT50000700000000000000111",
        accountName: "Flow Test",
        openingBalance: 0,
        openingBalanceDate: "2099-01-01",
      },
      { headers },
    );
    bankAccountId = ba.id as string;

    const { data: sp } = await client.admin.createSupplier(
      { name: "EDP Flow Test" },
      { headers },
    );
    supplierId = sp.id as string;
  });

  // ─── Cenário 1: reverse de bank_tx negativa (saída a fornecedor) ──────
  let outflowTxId = "";
  let supplierChargeId = "";

  it("cenario 1 - cria fatura supplier + bank_tx -50€ + concilia", async () => {
    const headers = fx.hdr();

    const { data: chg } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "supplier_service",
        description: "Fatura EDP flow test",
        issueDate: "2099-04-01",
        dueDate: "2099-04-30",
        competencePeriod: "2099-04-01",
        amountCents: 5000,
        supplierId,
      },
      { headers },
    );
    supplierChargeId = chg.id as string;

    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2099-04-15",
        amount: -5000,
        description: "Pagto EDP",
      },
      { headers },
    );
    outflowTxId = tx.id as string;

    // Concilia via /allocate_to_supplier (UI: clica "conciliar" + escolhe fornecedor).
    const allocResp = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/bank_transactions/${outflowTxId}/allocate_to_supplier`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId }),
      },
    );
    assertEquals(allocResp.status, 201);
    await allocResp.body?.cancel();

    // Verificar estado: fatura paga + bank_tx reconciled.
    const { data: chgAfter } = await client.admin.getCharge(supplierChargeId, { headers });
    assertEquals((chgAfter as unknown as { status: string }).status, "paid");
  });

  it("cenario 1 - reverte bank_tx negativa e fatura volta a aberto", async () => {
    const headers = fx.hdr();

    const { data, status } = await client.admin.reverseBankTransaction(
      outflowTxId,
      { reason: "Pagamento estornado pelo banco - cheque devolvido" },
      { headers },
    );
    assertEquals(status, 200);
    assertEquals(data.status, "reversed");

    // Fatura deve voltar ao estado aberto.
    const { data: chgAfter } = await client.admin.getCharge(supplierChargeId, { headers });
    const s = (chgAfter as unknown as { status: string; openAmount: number }).status;
    // due_date 2099-04-30 ainda futuro -> 'open'; se já tivesse passado seria 'overdue'.
    assertEquals(s === "open" || s === "overdue", true, `Esperado open/overdue, recebido ${s}`);
    assertEquals(
      (chgAfter as unknown as { openAmount: number }).openAmount,
      5000,
    );
  });

  // ─── Cenário 2: re-conciliar tx revertida ─────────────────────────────
  let reTxId = "";
  let openChargeId = "";

  it("cenario 2 - cria charge + bank_tx, concilia, reverte, re-concilia", async () => {
    const headers = fx.hdr();

    // Cria nova quota e bank_tx para o fluxo de re-conciliação.
    const { data: chg } = await client.admin.createCharge(
      {
        kind: "receivable",
        chargeType: "quota",
        description: "Quota Maio 2099",
        issueDate: "2099-05-01",
        dueDate: "2099-05-08",
        competencePeriod: "2099-05-01",
        amountCents: 10000,
        unitId: unit.id,
      },
      { headers },
    );
    openChargeId = chg.id as string;

    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2099-05-10",
        amount: 10000,
        description: "Pagto quota Maio",
      },
      { headers },
    );
    reTxId = tx.id as string;

    // 1ª conciliação.
    const alloc1 = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/bank_transactions/${reTxId}/allocate_to_unit`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ unitId: unit.id }),
      },
    );
    assertEquals(alloc1.status, 201);
    await alloc1.body?.cancel();

    // Reverte (gestor reparou que conciliou na unit errada).
    await client.admin.reverseBankTransaction(
      reTxId,
      { reason: "Conciliação errada - era de outra fração" },
      { headers },
    );
  });

  it("cenario 2 - re-allocate em tx 'reversed' deve passar", async () => {
    const headers = fx.hdr();

    // Re-conciliação na mesma unit (era o que o user queria fazer).
    const allocResp = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/bank_transactions/${reTxId}/allocate_to_unit`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ unitId: unit.id }),
      },
    );
    assertEquals(
      allocResp.status,
      201,
      "POST /allocate_to_unit em tx reversed deve passar",
    );
    await allocResp.body?.cancel();

    // Charge deve ficar paga novamente (settlements active criados de novo).
    const { data: chgAfter } = await client.admin.getCharge(openChargeId, { headers });
    assertEquals((chgAfter as unknown as { status: string }).status, "paid");
  });

  // ─── Cenário 3: ignore + unignore ──────────────────────────────────────
  let ignoreTxId = "";

  it("cenario 3 - ignore marca bank_tx como 'ignored'", async () => {
    const headers = fx.hdr();

    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2099-06-01",
        amount: -2000,
        description: "Transferência interna entre contas",
      },
      { headers },
    );
    ignoreTxId = tx.id as string;
    assertEquals((tx as unknown as { status: string }).status, "unreconciled");

    const { data, status } = await client.admin.ignoreBankTransaction(
      ignoreTxId,
      { headers },
    );
    assertEquals(status, 200);
    assertEquals(data.status, "ignored");
  });

  it("cenario 3 - allocate_to_supplier em tx 'ignored' deve falhar", async () => {
    const headers = fx.hdr();

    // Handler executeAllocation rejeita status='ignored' (validação TS).
    const resp = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/bank_transactions/${ignoreTxId}/allocate_to_supplier`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ supplierId }),
      },
    );
    // O handler embrulha a exception em 500 DB_ERROR (mensagem PT do raise).
    assertEquals(resp.status >= 400, true);
    assertEquals(resp.status < 600, true);
    await resp.body?.cancel();
  });

  it("cenario 3 - unignore volta para 'unreconciled'", async () => {
    const headers = fx.hdr();

    const { data, status } = await client.admin.unignoreBankTransaction(
      ignoreTxId,
      { headers },
    );
    assertEquals(status, 200);
    assertEquals(data.status, "unreconciled");
  });

  it("teardown - cleanup", async () => {
    await fx.cleanup();
  });
});
