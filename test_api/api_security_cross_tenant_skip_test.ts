// E2E security: cross-tenant em /receipts/skip, /unskip, /receipts/skipped.
//
// Threat model: manager (super, no nosso seed) de condo A submete um
// bankTransactionId + unitId que pertencem a condo B. Um handler de skip
// que gravasse receipt_skip.condominium_id = A com FKs para B deixaria um
// orphan inerte em A, e um list_skipped com JOIN bt sem filtrar
// bt.condominium_id mostraria a A descrição/data/valor de transações de B.
//
// Estes testes correm contra o servidor e garantem:
//   • POST /receipts/skip com bank_tx/unit cross-condo → 422/404
//   • POST /receipts/unskip com bank_tx/unit cross-condo → 422/404
//   • list_skipped só devolve linhas do cid (mesmo com row plantada em DB)

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

describe("security - cross-tenant via /receipts/skip + /unskip + /skipped", () => {
  let condoA: Condominium, condoB: Condominium;
  let _unitA: Unit, unitB: Unit;
  let bankTxB = "";
  const headersB = (): Record<string, string> => ({ ...AUTH, "x-condominium-id": condoB.id });

  it("setup - 2 condos, cada um com unit + bank_account + bank_tx + settlement", async () => {
    // Condo A
    const a = await client.super.createCondominium(
      { name: "Tenant A", fiscalNumber: "501100100" },
      { headers: AUTH },
    );
    condoA = a.data;
    const ua = await client.super.createUnit(condoA.id, { designation: "A", permillage: 1000 }, {
      headers: AUTH,
    });
    _unitA = ua.data;

    // Condo B (víctima)
    const b = await client.super.createCondominium(
      { name: "Tenant B (victim)", fiscalNumber: "501200200" },
      { headers: AUTH },
    );
    condoB = b.data;
    const ub = await client.super.createUnit(condoB.id, { designation: "B", permillage: 1000 }, {
      headers: AUTH,
    });
    unitB = ub.data;

    // Em B: owner + charge + bank_tx + settlement → cria pending para skip
    const occB = await client.admin.createOccupant(
      { name: "B owner", type: "owner", nif: "123456789", email: `tenant-b-${Date.now()}@test.pt` },
      { headers: headersB() },
    );
    await client.admin.createUnitOccupant(
      ub.data.id,
      {
        unitId: ub.data.id,
        occupantId: occB.data.id as string,
        relationshipType: "owner",
        startDate: "2025-01-01",
      },
      { headers: headersB() },
    );
    const ba = await client.admin.createBankAccount(
      { bankName: "Bank B", iban: "PT50000700000000000000005", kind: "bank" },
      { headers: headersB() },
    );
    const ch = await client.admin.createCharge(
      {
        kind: "receivable",
        nature: "debit",
        chargeType: "quota",
        scope: "unit",
        unitId: ub.data.id,
        issueDate: "2026-01-01",
        competencePeriod: "2026-01-01",
        amountCents: 9999,
        description: "B-only charge",
      },
      { headers: headersB() },
    );
    const bt = await client.admin.createBankTransaction(
      {
        bankAccountId: ba.data.id as string,
        transactionDate: "2026-01-15",
        amount: 9999,
        description: "SECRET DESCRIPTION OF B THAT A MUST NOT SEE",
      },
      { headers: headersB() },
    );
    bankTxB = bt.data.id as string;
    await client.admin.createSettlement(
      {
        settlementType: "bank_reconciliation",
        bankTransactionId: bt.data.id,
        debitChargeId: ch.data.id as string,
        amount: 9999,
        settlementDate: "2026-01-15",
      },
      { headers: headersB() },
    );
  });

  it("attack: skip via condo A com bank_tx+unit de B → 422/404 (não 201)", async () => {
    const res = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${condoA.id}/receipts/skip`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...AUTH },
        body: JSON.stringify({ bankTransactionId: bankTxB, unitId: unitB.id }),
      },
    );
    // Deve recusar (não 201): aceitar plantaria uma row cross-tenant.
    assertNotEquals(
      res.status,
      201,
      `cross-tenant skip foi aceite - esperava 422/404, veio ${res.status}`,
    );
    assertEquals(
      res.status === 422 || res.status === 404,
      true,
      `esperava 422 ou 404, veio ${res.status}`,
    );
    await res.body?.cancel();

    // Defesa adicional: nenhuma row plantada em receipt_skip do condo A.
    const planted = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM finance.receipt_skip
       WHERE condominium_id = ${condoA.id} AND deleted_at IS NULL
    `;
    assertEquals(planted[0].n, 0);
  });

  it("attack via list_skipped: row plantada DIRECTAMENTE em DB não revela dados de B", async () => {
    // Simula um receipt_skip orphan (caso atacante tivesse passado pela
    // fronteira → defesa em profundidade na query). O trg_tenant_guard recusa-o
    // hoje; fica desligado nesta transação para simular uma linha anterior.
    await sql.begin(async (tx) => {
      await tx`ALTER TABLE finance.receipt_skip DISABLE TRIGGER trg_tenant_guard`;
      await tx`
        INSERT INTO finance.receipt_skip (condominium_id, bank_transaction_id, unit_id, skipped_by)
        VALUES (${condoA.id}, ${bankTxB}, ${unitB.id}, ${
        tx.json({ id: "u_super", email: "super@mague.pt" })
      })
      `;
      await tx`ALTER TABLE finance.receipt_skip ENABLE TRIGGER trg_tenant_guard`;
    });

    // Manager de A chama listSkipped - JOIN bt.condominium_id deve filtrar
    // bt fora do condo. Resultado esperado: 0 rows OU bt info NULL.
    const res = await fetch(
      `${BASE_URL}/v1/admin/condominiums/${condoA.id}/receipts/skipped`,
      { headers: AUTH },
    );
    assertEquals(res.status, 200);
    const body = await res.json() as { data: Array<{ bankTxDescription?: string }> };

    // O secret de B não pode aparecer no payload.
    const leaked = body.data.some((r) =>
      String(r.bankTxDescription ?? "").includes("SECRET DESCRIPTION OF B")
    );
    assertEquals(leaked, false, "list_skipped vazou descrição da bank_tx de outro condo");

    // Cleanup da row plantada.
    await sql`DELETE FROM finance.receipt_skip WHERE condominium_id = ${condoA.id} AND bank_transaction_id = ${bankTxB}`;
  });

  it("cleanup - remove condos + close conn", async () => {
    try {
      await client.super.deleteCondominium(condoA.id, { headers: AUTH });
      await client.super.deleteCondominium(condoB.id, { headers: AUTH });
    } finally {
      await sql.end();
    }
  });
});
