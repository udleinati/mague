// E2E: GET /v1/admin/c/:cid/bank-accounts/with-stats
//
// Endpoint que pré-agrega stats (txCount, pendingCount, currentBalanceCents)
// para evitar puxar todas as bank_transactions só para mostrar saldos no
// painel. Antes não tinha cobertura E2E - exatamente onde apareceu o bug
// `column ba.updated_at does not exist` que fez a página falhar 500.

import { assertEquals, assertExists } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

describe("admin bank accounts /with-stats endpoint", () => {
  let fx: ScenarioFixture;
  let bankAccountId = "";

  const hdr = () => fx.hdr();

  it("setup - create condominium", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo("BankWithStats Test Condo")
      .build();
  });

  it("listBankAccountsWithStats - empty returns []", async () => {
    const { data, status } = await client.admin.listBankAccountsWithStats({ headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data, []);
  });

  it("create bank account so list has 1 row", async () => {
    const { data } = await client.admin.createBankAccount(
      {
        bankName: "Audit Bank",
        accountName: "Conta principal",
        iban: "PT50000100000000000000099",
        openingBalance: 50000, // 500.00€
        openingBalanceDate: "2026-01-01",
      },
      { headers: hdr() },
    );
    bankAccountId = data.id as string;
  });

  it("listBankAccountsWithStats - sem tx → currentBalance = openingBalance, counts = 0", async () => {
    const { data, status } = await client.admin.listBankAccountsWithStats({ headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data.length, 1);
    const acc = data[0] as Record<string, unknown> & {
      txCount: number;
      pendingCount: number;
      currentBalanceCents: number;
    };
    assertEquals(acc.id, bankAccountId);
    // Schema básico - apanha o bug ba.updated_at se reaparecer.
    assertEquals(typeof acc.bankName, "string");
    assertEquals(typeof acc.openingBalance, "number");
    assertEquals(typeof acc.createdAt, "string");
    // Stats: sem tx, currentBalance = openingBalance.
    assertEquals(acc.txCount, 0);
    assertEquals(acc.pendingCount, 0);
    assertEquals(acc.currentBalanceCents, 50000);
  });

  it("listBankAccountsWithStats - inclui tx → counts incrementam, balance ajusta", async () => {
    // Cria 1 bank_transaction (entrada de 100€, status default unreconciled).
    await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2026-03-15",
        description: "Audit credit",
        amount: 10000,
      },
      { headers: hdr() },
    );

    const { data } = await client.admin.listBankAccountsWithStats({ headers: hdr() });
    const acc = data[0] as Record<string, unknown> & {
      txCount: number;
      pendingCount: number;
      currentBalanceCents: number;
    };
    assertEquals(acc.txCount, 1);
    assertEquals(acc.pendingCount, 1); // unreconciled
    // Saldo = opening + Σ tx = 50000 + 10000.
    assertEquals(acc.currentBalanceCents, 60000);
  });

  it("listBankAccountsWithStats - response shape (sem updated_at)", async () => {
    // Regression test específico para o bug que motivou esta cobertura: a
    // query referenciava ba.updated_at mas a tabela não tem essa coluna.
    // Asseguramos que a resposta NÃO inclui `updatedAt` - se voltar a
    // aparecer, o código deve adicionar a coluna primeiro (migration).
    const { data } = await client.admin.listBankAccountsWithStats({ headers: hdr() });
    const acc = data[0] as Record<string, unknown>;
    assertEquals(acc.updatedAt, undefined, "schema mudou - adicionar coluna se for intencional");
    // Mas createdAt deve continuar lá.
    assertExists(acc.createdAt);
  });

  it("teardown - delete condominium", async () => {
    await fx.cleanup();
  });
});
