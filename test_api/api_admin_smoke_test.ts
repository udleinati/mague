// Smoke tests para áreas com pouca cobertura E2E:
//   • Bank account opening balance (M2)
//   • Chart of account regressão pós-move para schema finance (M5)
//
// O bloco "Manager CRUD" anterior cobria os endpoints /v1/.../managers/*
// que foram eliminados após ADR 0002. A funcionalidade equivalente vive
// agora em test_api/api_admin_user_manager_toggle_test.ts (PATCH user
// com isManager).
//
// Cada describe é isolado: cria o seu próprio condomínio + recursos,
// limpa no fim. Login: super (loginAsSuper helper).

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });

describe("admin smoke - opening balance / chart of account", () => {
  // ─── M2: Bank account opening balance ────────────────────────────────
  describe("bank account opening balance", () => {
    let condoId = "";
    let bankAccountId = "";
    let auth: { Authorization: string };

    it("setup", async () => {
      auth = await loginAsSuper();
      const { data: c } = await client.super.createCondominium(
        { name: "Smoke Bank Opening" },
        { headers: auth },
      );
      condoId = c.id;
      const headers = { ...auth, "x-condominium-id": condoId };
      const { data: ba } = await client.admin.createBankAccount(
        {
          bankName: "Smoke Bank",
          accountName: "Conta Ordinária",
          iban: "PT50000000000000000000017",
          kind: "bank",
        },
        { headers },
      );
      bankAccountId = String(ba.id);
    });

    it("setOpeningBalance ordinary 1000 + fcr 500 → ledger entries", async () => {
      const headers = { ...auth, "x-condominium-id": condoId };
      const { data, status } = await client.admin.setBankAccountOpeningBalance(
        bankAccountId,
        { ordinary_cents: 100000, fcr_cents: 50000, date: "2026-01-01" },
        { headers },
      );
      assertEquals(status, 201);
      assertEquals(data.openingBalanceOrdinaryCents, 100000);
      assertEquals(data.openingBalanceFcrCents, 50000);
      assertEquals(data.openingBalance, 150000);
    });

    it("teardown", async () => {
      await client.super.deleteCondominium(condoId, { headers: auth });
    });
  });

  // ─── M5: Chart of account regressão (pós-move para finance) ──────────
  describe("chart of account (regressão pós-move para schema finance)", () => {
    let condoId = "";
    let auth: { Authorization: string };

    it("setup", async () => {
      auth = await loginAsSuper();
      const { data: c } = await client.super.createCondominium(
        { name: "Smoke Chart" },
        { headers: auth },
      );
      condoId = c.id;
    });

    it("listExpenseCategories devolve plano global (>0 entries)", async () => {
      const headers = { ...auth, "x-condominium-id": condoId };
      const { data, status } = await client.admin.listExpenseCategories({ headers });
      assertEquals(status, 200);
      // Plano global tem ~58 entries (seeded via 000a_chart_of_account_global.sql)
      // Cada condomínio vê o global + os seus custom.
      assertEquals(data.length > 0, true, "plano de contas vazio?");
    });

    it("createChartOfAccount custom funciona", async () => {
      const headers = { ...auth, "x-condominium-id": condoId };
      const code = "cust." + crypto.randomUUID().substring(0, 6);
      const { data, status } = await client.admin.createChartOfAccount(
        { code, name: "Test custom", type: "expense" },
        { headers },
      );
      assertEquals(status, 201);
      assertEquals(data.code, code);
    });

    it("teardown", async () => {
      await client.super.deleteCondominium(condoId, { headers: auth });
    });
  });
});
