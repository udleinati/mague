// E2E: idempotência + lifecycle de receipt skip / unskip.
//
// Complementa o pgTAP `0054_receipt_skip_idempotency.sql` (DB-level) com
// validação ao nível da API:
//   1. skip 2x mesma (bt, unit) → 2ª devolve mesma row (id idêntico).
//   2. skip → unskip → skip novo → cria row nova (id diferente).
//   3. listSkippedReceipts mostra só os ativos.

import { assertEquals, assertNotEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Condominium, type Unit } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";
import { sqlExec } from "./_helpers/db.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });

describe("admin receipts - skip / unskip lifecycle + idempotência", () => {
  let auth: { Authorization: string };
  let condo: Condominium;
  let unit: Unit;
  let bankAccountId = "";
  let bankTxId = "";

  it("setup - condo + unit + bank_account + bank_tx", async () => {
    auth = await loginAsSuper();
    const { data: c } = await client.super.createCondominium(
      { name: "Skip lifecycle E2E" },
      { headers: auth },
    );
    condo = c;
    unit = (await client.super.createUnit(
      condo.id,
      { designation: "A", permillage: 1000 } as Record<string, unknown>,
      { headers: auth },
    )).data;

    const headers = { ...auth, "x-condominium-id": condo.id };
    const { data: acc } = await client.admin.createBankAccount(
      { bankName: "Test", iban: "PT50000201231234567890154", kind: "bank" } as Record<
        string,
        unknown
      >,
      { headers },
    );
    bankAccountId = String(acc.id);

    const { data: tx } = await client.admin.createBankTransaction(
      {
        bankAccountId,
        transactionDate: "2026-04-15",
        description: "Quota Abril",
        amount: 5000,
      } as Record<string, unknown>,
      { headers },
    );
    bankTxId = String(tx.id);
  });

  // ─── Idempotência ─────────────────────────────────────────────────────────

  it("skip 2x mesma (bt, unit) → 2ª devolve a mesma row ativa", async () => {
    const headers = { ...auth, "x-condominium-id": condo.id };
    const { data: first } = await client.admin.skipReceipt(
      { bankTransactionId: bankTxId, unitId: unit.id, reason: "primeiro skip" },
      { headers },
    );
    const { data: second } = await client.admin.skipReceipt(
      { bankTransactionId: bankTxId, unitId: unit.id, reason: "tentativa duplicada" },
      { headers },
    );
    // Mesma row ativa - handler devolve a existente em vez de duplicar.
    assertEquals(String(first.id), String(second.id));
  });

  // ─── Lifecycle: skip → unskip → skip novo ─────────────────────────────────

  it("após unskip, novo skip cria row nova (id diferente)", async () => {
    const headers = { ...auth, "x-condominium-id": condo.id };
    // Captura id do skip ativo atual.
    const { data: existing } = await client.admin.skipReceipt(
      { bankTransactionId: bankTxId, unitId: unit.id },
      { headers },
    );
    const oldId = String(existing.id);

    // Unskip (soft-delete da row ativa).
    const { data: unskipResult } = await client.admin.unskipReceipt(
      { bankTransactionId: bankTxId, unitId: unit.id },
      { headers },
    );
    assertEquals(unskipResult.reactivated, true);

    // Novo skip da mesma tupla cria row nova (constraint unique partial
    // só conta deleted_at IS NULL).
    const { data: newSkip } = await client.admin.skipReceipt(
      { bankTransactionId: bankTxId, unitId: unit.id, reason: "novo ciclo" },
      { headers },
    );
    assertNotEquals(String(newSkip.id), oldId);
  });

  it("listSkippedReceipts - retorna só o skip ativo (não os soft-deleted)", async () => {
    const headers = { ...auth, "x-condominium-id": condo.id };
    const { data } = await client.admin.listSkippedReceipts({ headers });
    // Já criámos 1 skip antigo (soft-deleted) + 1 novo (ativo).
    // listSkipped filtra por deleted_at IS NULL.
    const forOurTx = data.filter((r) => String(r.bankTransactionId) === bankTxId);
    assertEquals(
      forOurTx.length,
      1,
      "só 1 skip ativo deve aparecer (o anterior está soft-deleted)",
    );
  });

  // ─── Cross-tenant guard ───────────────────────────────────────────────────

  it("skip com bankTransactionId de outro condo → 422 CROSS_TENANT_REJECTED", async () => {
    // Cria 2º condo com bank_tx própria.
    const { data: c2 } = await client.super.createCondominium(
      { name: "Other condo" },
      { headers: auth },
    );
    const otherHeaders = { ...auth, "x-condominium-id": c2.id };
    const { data: acc2 } = await client.admin.createBankAccount(
      { bankName: "Other", iban: "PT50000201231234567899999", kind: "bank" } as Record<
        string,
        unknown
      >,
      { headers: otherHeaders },
    );
    const { data: otherTx } = await client.admin.createBankTransaction(
      {
        bankAccountId: String(acc2.id),
        transactionDate: "2026-04-15",
        description: "alheia",
        amount: 100,
      } as Record<string, unknown>,
      { headers: otherHeaders },
    );

    // Manager do condo original tenta skip da bank_tx do c2 → 422.
    const headers = { ...auth, "x-condominium-id": condo.id };
    try {
      await client.admin.skipReceipt(
        { bankTransactionId: String(otherTx.id), unitId: unit.id },
        { headers },
      );
      // Não deve chegar aqui.
      assertEquals(true, false, "esperado erro 422 cross-tenant");
    } catch (e) {
      // deno-lint-ignore no-explicit-any
      assertEquals((e as any).statusCode, 422);
    }

    await client.super.deleteCondominium(c2.id, { headers: auth });
  });

  it("teardown", async () => {
    await sqlExec(`DELETE FROM finance.receipt_skip WHERE condominium_id='${condo.id}'`);
    await client.super.deleteCondominium(condo.id, { headers: auth });
  });
});
