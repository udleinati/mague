// E2E security: coerência das pontas em POST /settlements (mesmo condomínio).
//
// Threat model: um gestor do próprio condomínio cria um `charge_offset` entre
// duas dívidas (ou com o crédito de outra fração) e marca charges como pagas
// sem dinheiro a mexer e sem rasto de cancelamento; ou concilia uma entrada
// bancária contra uma despesa (o ledger lançava Dr 121 / Cr despesa).
// Regras: debit_charge_id com nature='debit', credit_charge_id com
// nature='credit'; offset só entre charges do mesmo kind e, nas receivables, da
// mesma fração; o sinal do movimento tem de saldar a charge. O caso legítimo
// D11 (nota de crédito do fornecedor contra a fatura) continua a passar.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });

describe("security - pontas coerentes em POST /settlements", () => {
  let fx: ScenarioFixture;
  let quotaA1 = "";
  let quotaA2 = "";
  let creditB = "";
  let invoice = "";
  let creditNote = "";
  let incomingTx = "";

  const postSettlement = async (body: Record<string, unknown>) => {
    const res = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}/settlements`,
      {
        method: "POST",
        headers: { ...fx.hdr(), "Content-Type": "application/json" },
        body: JSON.stringify({ settlementDate: "2099-03-10", ...body }),
      },
    );
    return { status: res.status, body: await res.json() };
  };

  const charge = async (body: Record<string, unknown>) => {
    const { data } = await client.admin.createCharge(
      {
        issueDate: "2099-03-01",
        dueDate: "2099-03-31",
        competencePeriod: "2099-03-01",
        ...body,
      },
      { headers: fx.hdr() },
    );
    return data.id as string;
  };

  const openOf = async (id: string) => {
    const { data } = await client.admin.getCharge(id, { headers: fx.hdr() });
    return { open: Number(data.openAmount), status: data.status };
  };

  it("setup - frações A e B, quotas, crédito, fatura, nota de crédito, entrada", async () => {
    fx = await seedScenario(client, AUTH)
      .withCondo(`Settlement Sides ${Date.now()}`)
      .withUnit({ designation: "A", permillage: 500 })
      .withUnit({ designation: "B", permillage: 500 })
      .build();
    const [unitA, unitB] = fx.units;

    quotaA1 = await charge({
      kind: "receivable",
      chargeType: "quota",
      unitId: unitA.id,
      amountCents: 5000,
      description: "Quota A março",
    });
    quotaA2 = await charge({
      kind: "receivable",
      chargeType: "quota",
      unitId: unitA.id,
      amountCents: 3000,
      description: "Quota A extra",
    });
    creditB = await charge({
      kind: "receivable",
      nature: "credit",
      chargeType: "credit_adjustment",
      unitId: unitB.id,
      amountCents: 2000,
      description: "Crédito B",
    });
    invoice = await charge({
      kind: "payable",
      chargeType: "expense",
      amountCents: 10000,
      description: "Fatura limpeza",
    });
    creditNote = await charge({
      kind: "payable",
      nature: "credit",
      chargeType: "supplier_service",
      amountCents: 3000,
      description: "Nota de crédito limpeza",
    });

    const { data: ba } = await client.admin.createBankAccount(
      { bankName: "Banco Sides", iban: "PT50000700000000000077001", kind: "bank" },
      { headers: fx.hdr() },
    );
    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId: ba.id as string,
        transactionDate: "2099-03-10",
        amount: 5000,
        description: "TRF ENTRADA",
      },
      { headers: fx.hdr() },
    );
    incomingTx = (tx as { id: string }).id;
  });

  it("charge_offset entre duas dívidas → 400 e nenhuma fica paga", async () => {
    const res = await postSettlement({
      settlementType: "charge_offset",
      debitChargeId: quotaA1,
      creditChargeId: quotaA2,
      amount: 3000,
    });
    assertEquals(res.status, 400);
    assertEquals(res.body.error.code, "VALIDATION_ERROR");
    assertEquals(await openOf(quotaA1), { open: 5000, status: "open" });
    assertEquals(await openOf(quotaA2), { open: 3000, status: "open" });
  });

  it("charge_offset com o crédito de outra fração → 400", async () => {
    const res = await postSettlement({
      settlementType: "charge_offset",
      debitChargeId: quotaA1,
      creditChargeId: creditB,
      amount: 2000,
    });
    assertEquals(res.status, 400);
    assertEquals(res.body.error.code, "VALIDATION_ERROR");
    assertEquals((await openOf(creditB)).open, 2000);
  });

  it("entrada bancária contra fatura de fornecedor → 400 WRONG_SIGN", async () => {
    const res = await postSettlement({
      settlementType: "bank_reconciliation",
      bankTransactionId: incomingTx,
      debitChargeId: invoice,
      amount: 5000,
    });
    assertEquals(res.status, 400);
    assertEquals(res.body.error.code, "WRONG_SIGN");
    assertEquals((await openOf(invoice)).open, 10000);
  });

  it("D11: nota de crédito compensa a fatura do mesmo fornecedor → 201", async () => {
    const res = await postSettlement({
      settlementType: "charge_offset",
      debitChargeId: invoice,
      creditChargeId: creditNote,
      amount: 3000,
    });
    assertEquals(res.status, 201);
    assertEquals(await openOf(invoice), { open: 7000, status: "partial" });
    assertEquals(await openOf(creditNote), { open: 0, status: "paid" });
  });

  it("teardown", async () => {
    await fx.cleanup();
  });
});
