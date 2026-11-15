// E2E: paginação em listagens com volume - charges, receipts, bank_transactions.
//
// Recentemente adicionada (params `?page=N&perPage=N` em add às listas).
// Este teste assegura:
//   - Sem `page`, devolve até `limit` rows e SEM campo `pagination`.
//   - Com `page=1&perPage=N`, devolve só N rows + campo pagination com
//     totalPages correcto.
//   - `page=2` devolve a slice seguinte sem overlap com page=1.
//   - `perPage` cap (1000) é respeitado.

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Client, type Condominium } from "$shared/client/mod.ts";
import { loginAsSuper } from "./_helpers/auth.ts";

const BASE_URL = "http://localhost:3000";
const client = new Client({ baseUrl: BASE_URL });
const MASTER = await loginAsSuper();

describe("admin listings - pagination (charges/receipts/bank_tx)", () => {
  let condo: Condominium;

  const hdr = () => ({ ...MASTER, "x-condominium-id": condo.id });

  it("setup - condominium + 25 charges", async () => {
    const { data } = await client.super.createCondominium(
      { name: "Pagination Test Condo" },
      { headers: MASTER },
    );
    condo = data;

    // Cria 25 charges payable para ter um volume previsível.
    for (let i = 0; i < 25; i++) {
      await client.admin.createCharge(
        {
          kind: "payable",
          chargeType: "expense",
          description: `Despesa #${String(i + 1).padStart(2, "0")}`,
          issueDate: "2026-01-15",
          dueDate: "2026-02-01",
          competencePeriod: "2026-01-01",
          amountCents: 1000 + i,
        },
        { headers: hdr() },
      );
    }
  });

  // ─── Charges ─────────────────────────────────────────────────────────────

  it("listCharges sem page - devolve todas (sem campo pagination)", async () => {
    const { data, status, pagination } = await client.admin.listChargesWithMeta(
      { kind: "payable" },
      { headers: hdr() },
    );
    assertEquals(status, 200);
    assertEquals(data.length, 25);
    assertEquals(pagination, undefined);
  });

  it("listCharges com page=1&perPage=10 - devolve 10 + pagination correcta", async () => {
    const { data, pagination } = await client.admin.listChargesWithMeta(
      { kind: "payable", page: "1", perPage: "10" },
      { headers: hdr() },
    );
    assertEquals(data.length, 10);
    assertEquals(pagination, {
      page: 1,
      perPage: 10,
      total: 25,
      totalPages: 3,
    });
  });

  it("listCharges com page=2 - devolve a slice seguinte (sem overlap)", async () => {
    const page1 = await client.admin.listChargesWithMeta(
      { kind: "payable", page: "1", perPage: "10" },
      { headers: hdr() },
    );
    const page2 = await client.admin.listChargesWithMeta(
      { kind: "payable", page: "2", perPage: "10" },
      { headers: hdr() },
    );
    const ids1 = page1.data.map((c) => c.id);
    const ids2 = page2.data.map((c) => c.id);
    // Sem overlap.
    for (const id of ids2) {
      if (ids1.includes(id)) {
        throw new Error(`page2 contém id ${id} já visto em page1`);
      }
    }
    assertEquals(page2.data.length, 10);
    assertEquals(page2.pagination?.page, 2);
  });

  it("listCharges com page=3 - devolve as 5 últimas", async () => {
    const { data, pagination } = await client.admin.listChargesWithMeta(
      { kind: "payable", page: "3", perPage: "10" },
      { headers: hdr() },
    );
    assertEquals(data.length, 5); // 25 - 20
    assertEquals(pagination?.page, 3);
    assertEquals(pagination?.totalPages, 3);
  });

  it("listCharges com perPage acima do cap - cap respeitado", async () => {
    // Embora só tenhamos 25, podemos pedir perPage acima do cap - o servidor
    // cap'a a `maxPerPage` (10000 para charges, ver `charge/list.ts`).
    const { data, pagination } = await client.admin.listChargesWithMeta(
      { kind: "payable", page: "1", perPage: "50000" },
      { headers: hdr() },
    );
    assertEquals(data.length, 25); // todas
    if ((pagination?.perPage ?? 0) > 10000) {
      throw new Error(`perPage devia estar capped a 10000, recebido ${pagination?.perPage}`);
    }
  });

  // ─── Receipts ────────────────────────────────────────────────────────────
  // Pagination dos receipts foi adicionada com o mesmo padrão. Confirmamos
  // que o endpoint aceita os params sem erro mesmo com 0 recibos.

  it("listReceipts sem recibos + page=1 - devolve [] + pagination total=0", async () => {
    const { data, pagination } = await client.admin.listReceiptsWithMeta(
      { page: "1", perPage: "10" },
      { headers: hdr() },
    );
    assertEquals(data.length, 0);
    assertEquals(pagination?.page, 1);
    assertEquals(pagination?.perPage, 10);
    assertEquals(pagination?.total, 0);
    assertEquals(pagination?.totalPages, 1); // ceil(0/10) = 0 mas mínimo 1
  });

  // ─── Bank transactions ───────────────────────────────────────────────────

  it("listBankTransactions com page=1 sem tx - devolve [] + pagination", async () => {
    const { data, pagination } = await client.admin.listBankTransactionsWithMeta(
      { page: "1", perPage: "20" },
      { headers: hdr() },
    );
    assertEquals(data.length, 0);
    assertEquals(pagination?.page, 1);
    assertEquals(pagination?.total, 0);
  });

  it("teardown - delete condominium", async () => {
    await client.super.deleteCondominium(condo.id, { headers: MASTER });
  });
});
