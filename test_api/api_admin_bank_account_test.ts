import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { ApiError, Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { type ScenarioFixture, seedScenario } from "./_helpers/fixtures.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

describe("admin bank accounts", () => {
  let fx: ScenarioFixture;
  let accountId = "";

  it("setup - create condominium", async () => {
    fx = await seedScenario(client, MASTER)
      .withCondo("BankAccount Test Condo")
      .build();
  });

  const hdr = () => fx.hdr();

  it("list - empty returns []", async () => {
    const { data, status } = await client.admin.listBankAccounts({ headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data, []);
  });

  it("create - missing bankName returns 400", async () => {
    const e = await assertRejects(
      () => client.admin.createBankAccount({}, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 400);
  });

  it("create - valid payload returns 201", async () => {
    const { data, status } = await client.admin.createBankAccount(
      {
        bankName: "Millennium BCP",
        accountName: "Conta principal",
        iban: "PT50000100000000000000001",
        openingBalance: 50000,
        openingBalanceDate: "2026-01-01",
      },
      { headers: hdr() },
    );
    assertEquals(status, 201);
    assertEquals(data.bankName, "Millennium BCP");
    assertEquals(data.accountName, "Conta principal");
    assertEquals(data.openingBalance, 50000);
    assertEquals(data.isActive, true);
    accountId = data.id as string;
  });

  it("list - returns created account", async () => {
    const { data } = await client.admin.listBankAccounts({ headers: hdr() });
    assertEquals(data.length, 1);
    assertEquals(data[0].id, accountId);
  });

  it("get - returns account", async () => {
    const { data, status } = await client.admin.getBankAccount(accountId, { headers: hdr() });
    assertEquals(status, 200);
    assertEquals(data.id, accountId);
    assertEquals(data.bankName, "Millennium BCP");
  });

  it("get - non-existent returns 404", async () => {
    const e = await assertRejects(
      () => client.admin.getBankAccount("00000000000000000000000", { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("update - partial update returns 200", async () => {
    const { data, status } = await client.admin.updateBankAccount(
      accountId,
      { accountName: "Conta de poupança" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.accountName, "Conta de poupança");
    // Outros campos preservados.
    assertEquals(data.bankName, "Millennium BCP");
  });

  it("update - toggle isActive false", async () => {
    const { data } = await client.admin.updateBankAccount(
      accountId,
      { isActive: false },
      { headers: hdr() },
    );
    assertEquals(data.isActive, false);
  });

  // GET /bank-accounts/balances - agrega saldo por bolsa via ledger.
  it("getBankAccountsBalances - sem opening balance ainda é 0/0/0", async () => {
    const { data, status } = await client.admin.getBankAccountsBalances({ headers: hdr() });
    assertEquals(status, 200);
    assertEquals(typeof data.ordinaryCents, "number");
    assertEquals(typeof data.fcrCents, "number");
    assertEquals(typeof data.totalCents, "number");
    // Neste condomínio ainda não correu setOpeningBalance.
    assertEquals(data.ordinaryCents, 0);
    assertEquals(data.fcrCents, 0);
    assertEquals(data.totalCents, 0);
  });

  it("setBankAccountOpeningBalance - split ord+fcr refletido no balance", async () => {
    await client.admin.setBankAccountOpeningBalance(
      accountId,
      { ordinary_cents: 80000, fcr_cents: 20000, date: "2026-01-01" },
      { headers: hdr() },
    );
    const { data } = await client.admin.getBankAccountsBalances({ headers: hdr() });
    assertEquals(data.ordinaryCents, 80000);
    assertEquals(data.fcrCents, 20000);
    assertEquals(data.totalCents, 100000);
  });

  // getMe do condomínio devolve bankBalance embebido (via v_bank_balance).
  it("getMe (condominium) - inclui bankBalance vindo da view", async () => {
    const { data, status } = await client.admin.getMe({ headers: hdr() });
    assertEquals(status, 200);
    const b =
      (data as { bankBalance?: { ordinaryCents: number; fcrCents: number; totalCents: number } })
        .bankBalance;
    assertEquals(typeof b, "object");
    assertEquals(b!.ordinaryCents, 80000);
    assertEquals(b!.fcrCents, 20000);
    assertEquals(b!.totalCents, 100000);
  });

  it("delete - returns 204", async () => {
    const { status } = await client.admin.deleteBankAccount(accountId, { headers: hdr() });
    assertEquals(status, 204);
  });

  it("get - deleted returns 404", async () => {
    const e = await assertRejects(
      () => client.admin.getBankAccount(accountId, { headers: hdr() }),
      ApiError,
    );
    assertEquals(e.statusCode, 404);
  });

  it("teardown - delete condominium", async () => {
    await fx.cleanup();
  });
});
