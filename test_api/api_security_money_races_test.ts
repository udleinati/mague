// E2E security: pedidos concorrentes que duplicavam dinheiro.
//
// Threat model: dois POST em paralelo passavam ambos a verificação ("já tem saldo
// inicial?", "a bolsa cobre o montante?", "quanto falta refaturar?") feita fora da
// transação do INSERT. Agora cada handler tranca a linha-mãe (conta bancária,
// condomínio, charge de origem) e verifica dentro da mesma transação: o segundo
// pedido vê o primeiro e falha.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });

describe("security - corridas em operações de dinheiro", () => {
  let fx: ScenarioFixture;
  let bankAccountId = "";

  // Dispara o mesmo POST duas vezes em paralelo; devolve os status ordenados.
  const twice = async (path: string, body: Record<string, unknown>) => {
    const send = () =>
      fetch(`${BASE_URL}/v1/admin/condominiums/${fx.condominium.id}${path}`, {
        method: "POST",
        headers: { ...fx.hdr(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (res) => {
        await res.body?.cancel();
        return res.status;
      });
    const statuses = await Promise.all([send(), send()]);
    return statuses.sort((a, b) => a - b);
  };

  const balances = async () =>
    (await client.admin.getBankAccountsBalances({ headers: fx.hdr() })).data;

  it("setup - condo + fração + conta bancária sem saldo inicial", async () => {
    fx = await seedScenario(client, AUTH)
      .withCondo(`Money Races ${Date.now()}`)
      .withUnit({ designation: "A" })
      .build();
    const { data: ba } = await client.admin.createBankAccount(
      { bankName: "Banco Races", iban: "PT50000700000000000077002", kind: "bank" },
      { headers: fx.hdr() },
    );
    bankAccountId = ba.id as string;
  });

  it("saldo inicial em paralelo: um 201, um 409, saldo não duplica", async () => {
    const statuses = await twice(`/bank-accounts/${bankAccountId}/opening-balance`, {
      ordinary_cents: 10000,
      fcr_cents: 1000,
      date: "2099-01-01",
    });
    assertEquals(statuses, [201, 409]);

    const bal = await balances();
    assertEquals(bal.ordinaryCents, 10000);
    assertEquals(bal.fcrCents, 1000);
  });

  it("transferência para FCR em paralelo: a bolsa ordinária não fica negativa", async () => {
    // 2 x 8000 sobre 10000 disponíveis: só uma cabe.
    const statuses = await twice("/fcr-transfers", {
      direction: "to_fcr",
      amountCents: 8000,
      date: "2099-01-15",
      reason: "Reforço do fundo",
    });
    assertEquals(statuses, [201, 422]);

    const bal = await balances();
    assertEquals(bal.ordinaryCents, 2000);
    assertEquals(bal.fcrCents, 9000);
  });

  it("refaturação em paralelo: não refatura acima da fatura original", async () => {
    const { data: invoice } = await client.admin.createCharge(
      {
        kind: "payable",
        chargeType: "expense",
        description: "Reparação canalização",
        issueDate: "2099-02-01",
        dueDate: "2099-02-28",
        competencePeriod: "2099-02-01",
        amountCents: 10000,
      },
      { headers: fx.hdr() },
    );
    const invoiceId = invoice.id as string;

    // 2 x 8000 sobre uma fatura de 10000: só um lote cabe.
    const statuses = await twice(`/charges/${invoiceId}/refacturations`, {
      allocations: [{ unitId: fx.units[0].id, amountCents: 8000 }],
      issueDate: "2099-02-05",
      dueDate: "2099-03-31",
    });
    assertEquals(statuses, [201, 400]);

    const { data: refacts } = await client.admin.listCharges(
      { chargeType: "refacturation", sourceId: invoiceId },
      { headers: fx.hdr() },
    );
    assertEquals(refacts.length, 1);
    assertEquals(Number(refacts[0].originalAmount), 8000);
  });

  it("teardown", async () => {
    await fx.cleanup();
  });
});
