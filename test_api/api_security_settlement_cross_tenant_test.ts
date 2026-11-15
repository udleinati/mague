// E2E security: cross-tenant em POST /settlements.
//
// Threat model: manager de condo A submete settlement com bankTransactionId
// e/ou debitChargeId/creditChargeId que pertencem a condo B. Se validateInTx
// filtrasse só por id (sem condominium_id), o INSERT passaria e o ledger de A
// ficaria com entries linkadas a entidades de B (corrupção contabilística +
// data leak).
//
// validateInTx (ou camada superior) tem de garantir que TODOS os IDs do body
// pertencem ao condominium do path. Esperado: 422.

import { assertEquals, assertNotEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import postgresjs from "postgresjs";
import { Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const DATABASE_URL = Deno.env.get("DATABASE_URL") ??
  "postgres://mague:mague@localhost:5432/mague";
const AUTH = await loginAsSuper();
const client = new Client({ baseUrl: BASE_URL });
const sql = postgresjs(DATABASE_URL, { max: 2 });

describe("security - cross-tenant via POST /settlements", () => {
  let condoA: Condominium, condoB: Condominium;
  let _unitA: Unit, _unitB: Unit;
  let chargeB = ""; // charge de condo B
  let bankTxB = ""; // bank_tx de condo B

  it("setup - 2 condos com unit + charge + bank_tx em B (intactos)", async () => {
    const a = await client.super.createCondominium(
      { name: "Settle Tenant A", fiscalNumber: "501301010" },
      { headers: AUTH },
    );
    condoA = a.data;
    const ua = await client.super.createUnit(condoA.id, { designation: "A", permillage: 1000 }, {
      headers: AUTH,
    });
    _unitA = ua.data;
    // Bank account em A para que possamos criar uma bank_tx legítima de A
    await client.admin.createBankAccount(
      { bankName: "Bank A", iban: "PT50000700000000000000010", kind: "bank" },
      { headers: { ...AUTH, "x-condominium-id": condoA.id } },
    );

    const b = await client.super.createCondominium(
      { name: "Settle Tenant B", fiscalNumber: "501302020" },
      { headers: AUTH },
    );
    condoB = b.data;
    const ub = await client.super.createUnit(condoB.id, { designation: "B", permillage: 1000 }, {
      headers: AUTH,
    });
    _unitB = ub.data;
    const headersB = { ...AUTH, "x-condominium-id": condoB.id };
    const baB = await client.admin.createBankAccount(
      { bankName: "Bank B", iban: "PT50000700000000000000020", kind: "bank" },
      { headers: headersB },
    );
    const ch = await client.admin.createCharge(
      {
        kind: "receivable",
        nature: "debit",
        chargeType: "quota",
        scope: "unit",
        unitId: ub.data.id,
        issueDate: "2026-02-01",
        competencePeriod: "2026-02-01",
        amountCents: 5000,
        description: "B charge",
      },
      { headers: headersB },
    );
    chargeB = ch.data.id as string;
    const bt = await client.admin.createBankTransaction(
      {
        bankAccountId: baB.data.id as string,
        transactionDate: "2026-02-15",
        amount: 5000,
        description: "B bank tx",
      },
      { headers: headersB },
    );
    bankTxB = bt.data.id as string;
  });

  it("attack: criar settlement em A com bankTransactionId de B → 422", async () => {
    const res = await fetch(`${BASE_URL}/v1/admin/condominiums/${condoA.id}/settlements`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({
        settlementType: "bank_reconciliation",
        bankTransactionId: bankTxB, // ← cross-tenant
        debitChargeId: chargeB, // ← cross-tenant
        amount: 5000,
        settlementDate: "2026-02-15",
      }),
    });
    assertNotEquals(
      res.status,
      201,
      `cross-tenant settlement aceite - esperava 422, veio ${res.status}`,
    );
    assertEquals(res.status === 422 || res.status === 404 || res.status === 400, true);
    await res.body?.cancel();

    // DB: não pode existir settlement em A com bank_tx de B
    const planted = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM finance.settlement
       WHERE condominium_id = ${condoA.id}
         AND bank_transaction_id = ${bankTxB}
    `;
    assertEquals(planted[0].n, 0);
  });

  it("attack via charge_offset: debit + credit charge ambos de B → 422", async () => {
    // charge_offset não usa bank_tx; usa 2 charges. Repete o ataque.
    const res = await fetch(`${BASE_URL}/v1/admin/condominiums/${condoA.id}/settlements`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH },
      body: JSON.stringify({
        settlementType: "charge_offset",
        debitChargeId: chargeB,
        creditChargeId: chargeB,
        amount: 5000,
        settlementDate: "2026-02-15",
      }),
    });
    assertNotEquals(res.status, 201);
    await res.body?.cancel();
  });

  it("cleanup", async () => {
    try {
      await client.super.deleteCondominium(condoA.id, { headers: AUTH });
      await client.super.deleteCondominium(condoB.id, { headers: AUTH });
    } finally {
      await sql.end();
    }
  });
});
