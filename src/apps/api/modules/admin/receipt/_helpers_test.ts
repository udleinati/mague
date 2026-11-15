// Unit tests das funções puras do pipeline de emissão. As fases I/O
// (`runReceiptTransaction`, `notifyRecipients`) ficam nos E2E em test_api/api_admin_receipt_*.

import { assertEquals } from "@std/assert";
import { amountInWords, humanizeChargeLine, maskIban } from "./format.ts";

// ─── maskIban ────────────────────────────────────────────────────────────────

Deno.test("maskIban - null devolve null", () => {
  assertEquals(maskIban(null), null);
});

Deno.test("maskIban - IBAN demasiado curto fica intacto", () => {
  assertEquals(maskIban("PT50"), "PT50");
});

Deno.test("maskIban - IBAN PT25 caracteres mascara o meio", () => {
  const result = maskIban("PT50 0033 0000 4567 8901 2345 6");
  // Preserva head (8) + tail (4), mascara o meio.
  assertEquals(result?.startsWith("PT500033"), true);
  assertEquals(result?.endsWith("3456"), true);
  assertEquals(result?.includes("4567") && result.indexOf("4567") < 10, false);
});

Deno.test("maskIban - normaliza espaços de input", () => {
  const a = maskIban("PT50000700000000000077777");
  const b = maskIban("PT50 0007 0000 0000 0000 7777 7");
  assertEquals(a, b);
});

// ─── humanizeChargeLine ──────────────────────────────────────────────────────

Deno.test("humanizeChargeLine - quota com competence_period vira 'Quota Mês/Ano'", () => {
  assertEquals(
    humanizeChargeLine("ignored", "quota", "2026-03-01"),
    "Quota Março/2026",
  );
});

Deno.test("humanizeChargeLine - quota sem competence cai para description", () => {
  assertEquals(
    humanizeChargeLine("Quota mensal", "quota", null),
    "Quota mensal",
  );
});

Deno.test("humanizeChargeLine - quota com competence inválido cai para description", () => {
  assertEquals(
    humanizeChargeLine("Fallback", "quota", "not-a-date"),
    "Fallback",
  );
});

Deno.test("humanizeChargeLine - credit_balance é 'Adiantamento à conta'", () => {
  assertEquals(
    humanizeChargeLine("ignored", "credit_balance", null),
    "Adiantamento à conta",
  );
});

Deno.test("humanizeChargeLine - extraordinary_quota usa description ou fallback", () => {
  assertEquals(
    humanizeChargeLine("Obra fachada", "extraordinary_quota", null),
    "Obra fachada",
  );
  assertEquals(
    humanizeChargeLine("", "extraordinary_quota", null),
    "Quota extraordinária",
  );
});

Deno.test("humanizeChargeLine - tipo desconhecido devolve description", () => {
  assertEquals(
    humanizeChargeLine("Imposto IUC", "unknown_type", null),
    "Imposto IUC",
  );
});

Deno.test("humanizeChargeLine - description vazia + tipo desconhecido devolve o tipo", () => {
  assertEquals(humanizeChargeLine("", "supplier_service", null), "supplier_service");
});

// ─── amountInWords ───────────────────────────────────────────────────────────

Deno.test("amountInWords - zero", () => {
  assertEquals(amountInWords(0), "Zero euros");
});

Deno.test("amountInWords - só cêntimos omite os euros", () => {
  assertEquals(amountInWords(1), "Um cêntimo");
  assertEquals(amountInWords(35), "Trinta e cinco cêntimos");
});

Deno.test("amountInWords - 1 euro singular", () => {
  assertEquals(amountInWords(100), "Um euro");
});

Deno.test("amountInWords - euros + cêntimos por extenso", () => {
  assertEquals(amountInWords(2350), "Vinte e três euros e cinquenta cêntimos");
});

Deno.test("amountInWords - euros sem cêntimos", () => {
  assertEquals(amountInWords(5000), "Cinquenta euros");
});

Deno.test("amountInWords - euros + 1 cêntimo singular", () => {
  assertEquals(amountInWords(2501), "Vinte e cinco euros e um cêntimo");
});

Deno.test("amountInWords - euros e cêntimos (505,35 €)", () => {
  assertEquals(
    amountInWords(50535),
    "Quinhentos e cinco euros e trinta e cinco cêntimos",
  );
});

Deno.test("amountInWords - grafia PT-PT nas dezenas irregulares", () => {
  // dezasseis/dezassete/dezanove (PT-PT), não dezesseis/dezessete/dezenove (BR).
  assertEquals(amountInWords(1600), "Dezasseis euros");
  assertEquals(amountInWords(1719), "Dezassete euros e dezanove cêntimos");
});

Deno.test("amountInWords - centenas: cem exato vs cento e", () => {
  assertEquals(amountInWords(10000), "Cem euros");
  assertEquals(amountInWords(10100), "Cento e um euros");
});

Deno.test("amountInWords - milhares com conector 'e' correto", () => {
  // "e" liga o grupo final < 100 ou centena redonda; caso contrário omite-se.
  assertEquals(amountInWords(100000), "Mil euros");
  assertEquals(amountInWords(120000), "Mil e duzentos euros");
  assertEquals(
    amountInWords(123456),
    "Mil duzentos e trinta e quatro euros e cinquenta e seis cêntimos",
  );
  assertEquals(amountInWords(103400), "Mil e trinta e quatro euros");
  assertEquals(amountInWords(200000), "Dois mil euros");
});

Deno.test("amountInWords - negativos tratados como módulo", () => {
  // Casos de void/refund podem chamar com negativos. Deve devolver positivo.
  assertEquals(amountInWords(-2350), "Vinte e três euros e cinquenta cêntimos");
});
