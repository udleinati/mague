import { assertEquals, assertNotEquals } from "@std/assert";
import { importHash } from "./hash.ts";

const baseFields = {
  bankAccountId: "ba_xyz",
  transactionDate: "2026-05-03",
  amountCents: 12345,
  description: "TRF DE Joao Silva",
  balanceAfterCents: 100000,
};

Deno.test("importHash: determinístico - mesmos inputs → mesmo hash", async () => {
  const h1 = await importHash(baseFields);
  const h2 = await importHash(baseFields);
  assertEquals(h1, h2);
});

Deno.test("importHash: SHA-256 hex (64 chars 0-9a-f)", async () => {
  const h = await importHash(baseFields);
  assertEquals(h.length, 64);
  assertEquals(/^[0-9a-f]{64}$/.test(h), true);
});

Deno.test("importHash: bankAccountId diferente → hash diferente", async () => {
  const h1 = await importHash(baseFields);
  const h2 = await importHash({ ...baseFields, bankAccountId: "ba_OUTRA" });
  assertNotEquals(h1, h2);
});

Deno.test("importHash: amountCents diferente → hash diferente", async () => {
  const h1 = await importHash(baseFields);
  const h2 = await importHash({ ...baseFields, amountCents: 12346 });
  assertNotEquals(h1, h2);
});

Deno.test("importHash: balanceAfterCents distingue movs idênticos no mesmo dia", async () => {
  // Exemplo: 2 cobranças SDD de 50,00 da mesma entidade no mesmo dia.
  // Sem balanceAfterCents seriam idênticos; com ele, distingue.
  const tx1 = { ...baseFields, balanceAfterCents: 100000 };
  const tx2 = { ...baseFields, balanceAfterCents: 99000 }; // saldo após 2ª
  const h1 = await importHash(tx1);
  const h2 = await importHash(tx2);
  assertNotEquals(h1, h2);
});

Deno.test("importHash: balanceAfterCents=null tratado como '-' (placeholder)", async () => {
  // Bancos que não dão saldo após cada movimento: null vira '-' no canonical.
  const h1 = await importHash({ ...baseFields, balanceAfterCents: null });
  const h2 = await importHash({ ...baseFields, balanceAfterCents: null });
  assertEquals(h1, h2);
  // Mas '-' é diferente de saldo numérico real.
  const h3 = await importHash({ ...baseFields, balanceAfterCents: 0 });
  assertNotEquals(h1, h3);
});

Deno.test("importHash: descrição com acentos é tratada como UTF-8", async () => {
  const h1 = await importHash({ ...baseFields, description: "Cobrança Água" });
  const h2 = await importHash({ ...baseFields, description: "Cobrança Água" });
  assertEquals(h1, h2);
  // Sem acentos é hash diferente - case real onde o banco normaliza descrição.
  const h3 = await importHash({ ...baseFields, description: "Cobranca Agua" });
  assertNotEquals(h1, h3);
});
