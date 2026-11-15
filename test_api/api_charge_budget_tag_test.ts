// E2E: PATCH /charges/:id/budget - a etiqueta despesa -> orçamento que o
// relatório por Ata usa para desempatar rubricas partilhadas.
//
// Três invariantes, contra o servidor real:
//   1. Etiquetar uma despesa JÁ PAGA tem de funcionar. É a razão de existir um
//      endpoint separado: `PATCH /charges/:id` recusa charges liquidadas, e
//      etiquetar histórico é o caso normal deste relatório.
//   2. Cross-tenant: manager de A não pode etiquetar com orçamento de B - a FK
//      do Postgres só verifica existência, não tenant.
//   3. Quotas não se etiquetam - já apontam ao orçamento por source_type/id.

import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client, type Condominium } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });

describe("charge budget tag - PATCH /charges/:id/budget", () => {
  let condoA: Condominium, condoB: Condominium;
  let budgetA = "", budgetB = "";
  let payableA = "", receivableA = "";
  const hdrA = () => ({ ...AUTH, "x-condominium-id": condoA.id });

  it("setup - 2 condos, cada um com orçamento; despesa e quota em A", async () => {
    const a = await client.super.createCondominium(
      { name: "Budget Tag A", fiscalNumber: "501401010" },
      { headers: AUTH },
    );
    condoA = a.data;
    const unitA = await client.super.createUnit(
      condoA.id,
      { designation: "A", permillage: 1000 },
      { headers: AUTH },
    );

    const b = await client.super.createCondominium(
      { name: "Budget Tag B", fiscalNumber: "501402020" },
      { headers: AUTH },
    );
    condoB = b.data;

    budgetA = (await client.admin.createBudget({ year: "2030" }, { headers: hdrA() })).data.id;
    budgetB = (await client.admin.createBudget({ year: "2030" }, {
      headers: { ...AUTH, "x-condominium-id": condoB.id },
    })).data.id;

    payableA = (await client.admin.createCharge({
      kind: "payable",
      chargeType: "expense",
      description: "Fatura da obra",
      issueDate: "2030-03-01",
      dueDate: "2030-03-31",
      competencePeriod: "2030-03-01",
      amountCents: 10000,
    }, { headers: hdrA() })).data.id;

    receivableA = (await client.admin.createCharge({
      kind: "receivable",
      nature: "debit",
      chargeType: "quota",
      unitId: unitA.data.id,
      description: "Quota",
      issueDate: "2030-03-01",
      competencePeriod: "2030-03-01",
      amountCents: 5000,
    }, { headers: hdrA() })).data.id;
  });

  it("etiqueta uma despesa e a etiqueta persiste", async () => {
    const res = await client.admin.setChargeBudget(payableA, budgetA, { headers: hdrA() });
    assertEquals(res.data.budgetId, budgetA);
    // O relatório lê da BD, não da resposta.
    const reread = await client.admin.getCharge(payableA, { headers: hdrA() });
    assertEquals(reread.data.budgetId, budgetA);
  });

  it("limpar a etiqueta devolve a despesa à inferência", async () => {
    const res = await client.admin.setChargeBudget(payableA, null, { headers: hdrA() });
    assertEquals(res.data.budgetId, null);
  });

  it("etiqueta despesa JÁ PAGA - é o caso normal do relatório histórico", async () => {
    const { data: ba } = await client.admin.createBankAccount({
      bankName: "Banco Budget Tag",
      iban: "PT50000700000000000000041",
      accountName: "Budget tag",
      openingBalance: 0,
      openingBalanceDate: "2030-01-01",
    }, { headers: hdrA() });
    const { data: tx } = await client.admin.createBankTransaction({
      bankAccountId: (ba as { id: string }).id,
      transactionDate: "2030-03-05",
      amount: -10000,
      description: "PAG OBRA",
    }, { headers: hdrA() });

    const settleRes = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${condoA.id}/settlements`,
      {
        method: "POST",
        headers: { ...hdrA(), "Content-Type": "application/json" },
        body: JSON.stringify({
          settlementType: "bank_reconciliation",
          bankTransactionId: (tx as { id: string }).id,
          debitChargeId: payableA,
          amount: 10000,
          settlementDate: "2030-03-05",
        }),
      },
    );
    assertEquals(settleRes.status, 201);
    await settleRes.body?.cancel();

    const paid = await client.admin.getCharge(payableA, { headers: hdrA() });
    assertEquals(Number(paid.data.settledAmount), 10000, "pré-condição: despesa liquidada");

    // O PATCH geral recusa - é por isso que a etiqueta tem endpoint próprio.
    const blocked = await assertRejects(
      () => client.admin.updateCharge(payableA, { description: "x" }, { headers: hdrA() }),
      ApiError,
    );
    assertEquals(blocked.statusCode, 409);

    const res = await client.admin.setChargeBudget(payableA, budgetA, { headers: hdrA() });
    assertEquals(res.data.budgetId, budgetA);
  });

  it("cross-tenant: orçamento de B não etiqueta despesa de A", async () => {
    const e = await assertRejects(
      () => client.admin.setChargeBudget(payableA, budgetB, { headers: hdrA() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
    const reread = await client.admin.getCharge(payableA, { headers: hdrA() });
    assertEquals(reread.data.budgetId, budgetA, "a etiqueta anterior fica intacta");
  });

  it("quota não se etiqueta - já aponta ao orçamento por sourceType/sourceId", async () => {
    const e = await assertRejects(
      () => client.admin.setChargeBudget(receivableA, budgetA, { headers: hdrA() }),
      ApiError,
    );
    assertEquals(e.statusCode, 422);
  });

  it("cleanup", async () => {
    await client.super.deleteCondominium(condoA.id, { headers: AUTH }).catch(() => {});
    await client.super.deleteCondominium(condoB.id, { headers: AUTH }).catch(() => {});
  });
});
