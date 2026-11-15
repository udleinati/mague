import { assertEquals } from "@std/assert";
import { formatDate, formatMoney } from "./render.ts";

// ─── formatMoney ─────────────────────────────────────────────────────

Deno.test("formatMoney: 0 cêntimos → '0,00 €'", () => {
  assertEquals(formatMoney(0), "0,00 €");
});

Deno.test("formatMoney: valor pequeno (cêntimos)", () => {
  assertEquals(formatMoney(1), "0,01 €");
  assertEquals(formatMoney(50), "0,50 €");
  assertEquals(formatMoney(99), "0,99 €");
});

Deno.test("formatMoney: valor sem decimais arredondados", () => {
  assertEquals(formatMoney(100), "1,00 €");
  assertEquals(formatMoney(1000), "10,00 €");
});

Deno.test("formatMoney: valor com separador de milhares (PT)", () => {
  assertEquals(formatMoney(123456), "1.234,56 €");
  assertEquals(formatMoney(1234567), "12.345,67 €");
  assertEquals(formatMoney(1000000), "10.000,00 €");
});

Deno.test("formatMoney: valor negativo", () => {
  assertEquals(formatMoney(-123456), "-1.234,56 €");
  assertEquals(formatMoney(-50), "-0,50 €");
});

Deno.test("formatMoney: aceita string numérica", () => {
  assertEquals(formatMoney("12345"), "123,45 €");
  assertEquals(formatMoney("0"), "0,00 €");
});

Deno.test("formatMoney: input inválido → '0,00 €'", () => {
  assertEquals(formatMoney(null), "0,00 €");
  assertEquals(formatMoney(undefined), "0,00 €");
  assertEquals(formatMoney("abc"), "0,00 €");
  assertEquals(formatMoney(NaN), "0,00 €");
  assertEquals(formatMoney(Infinity), "0,00 €");
});

Deno.test("formatMoney: número fracionário trunca cêntimos sem arredondar", () => {
  // Math.trunc garante que valores como 99.9 viram 0 euros + 99 cêntimos
  // (remainder com Math.abs faz módulo corretamente).
  assertEquals(formatMoney(99), "0,99 €"); // 0 euros, 99 cêntimos
});

// ─── formatDate ──────────────────────────────────────────────────────

Deno.test("formatDate: ISO string → dd/mm/yyyy", () => {
  assertEquals(formatDate("2026-05-03"), "03/05/2026");
  assertEquals(formatDate("2026-12-31"), "31/12/2026");
  assertEquals(formatDate("2026-01-01"), "01/01/2026");
});

Deno.test("formatDate: ISO com tempo → ignora o tempo", () => {
  assertEquals(formatDate("2026-05-03T15:30:00Z"), "03/05/2026");
});

Deno.test("formatDate: Date object", () => {
  // UTC para evitar problemas de TZ no test.
  assertEquals(formatDate(new Date("2026-05-03T00:00:00Z")), "03/05/2026");
});

Deno.test("formatDate: vazio/null → '-'", () => {
  assertEquals(formatDate(null), "-");
  assertEquals(formatDate(undefined), "-");
  assertEquals(formatDate(""), "-");
  assertEquals(formatDate(0), "-");
});

Deno.test("formatDate: input inválido → devolve string original", () => {
  assertEquals(formatDate("not a date"), "not a date");
  assertEquals(formatDate("2099-13-99"), "2099-13-99");
});
