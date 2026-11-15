import { assertEquals } from "@std/assert";
import { formatDate, formatMoney, formatPermillage } from "./mod.ts";

// ─── formatMoney ─────────────────────────────────────────────────────

Deno.test("formatMoney: 0 cêntimos → '0,00 €'", () => {
  assertEquals(formatMoney(0), "0,00 €");
});

Deno.test("formatMoney: valores pequenos e sem decimais", () => {
  assertEquals(formatMoney(1), "0,01 €");
  assertEquals(formatMoney(50), "0,50 €");
  assertEquals(formatMoney(99), "0,99 €");
  assertEquals(formatMoney(100), "1,00 €");
  assertEquals(formatMoney(1000), "10,00 €");
});

Deno.test("formatMoney: separador de milhares (PT)", () => {
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

// ─── formatPermillage ────────────────────────────────────────────────

Deno.test("formatPermillage: 2 decimais fixas, estilo PT", () => {
  assertEquals(formatPermillage(45.321), "45,32");
  assertEquals(formatPermillage(1234.5), "1.234,50");
  assertEquals(formatPermillage(0), "0,00");
  assertEquals(formatPermillage(1000), "1.000,00");
});

Deno.test("formatPermillage: aceita string numérica (colunas numeric)", () => {
  assertEquals(formatPermillage("125.5"), "125,50");
  assertEquals(formatPermillage("1000"), "1.000,00");
});

Deno.test("formatPermillage: negativo e inválido", () => {
  assertEquals(formatPermillage(-12.345), "-12,35");
  assertEquals(formatPermillage("abc"), "0,00");
  assertEquals(formatPermillage(null), "0,00");
});

// ─── formatDate ──────────────────────────────────────────────────────

Deno.test("formatDate: date-only por parse textual, sem timezone", () => {
  assertEquals(formatDate("2026-05-03"), "03/05/2026");
  assertEquals(formatDate("2026-12-31"), "31/12/2026");
  assertEquals(formatDate("2026-01-01"), "01/01/2026");
});

Deno.test("formatDate: timestamp formata em UTC (23:xx não vira o dia)", () => {
  // Independente do TZ local: 23:30 UTC do dia 3 fica dia 3 (o fork local do
  // panel mostrava dia 4 em TZ ≥ +1 - a decisão do módulo é UTC).
  assertEquals(formatDate("2026-05-03T23:30:00Z"), "03/05/2026");
  assertEquals(formatDate(new Date("2026-05-03T23:30:00Z")), "03/05/2026");
});

Deno.test("formatDate: ISO com tempo → ignora o tempo", () => {
  assertEquals(formatDate("2026-05-03T15:30:00Z"), "03/05/2026");
});

Deno.test("formatDate: null/vazio/inválido → ''", () => {
  assertEquals(formatDate(null), "");
  assertEquals(formatDate(undefined), "");
  assertEquals(formatDate(""), "");
  assertEquals(formatDate("not a date"), "");
  assertEquals(formatDate("2099-13-99"), "");
});

Deno.test("formatDate: epoch millis formata em UTC", () => {
  assertEquals(formatDate(Date.UTC(2026, 4, 3, 23, 30)), "03/05/2026");
});
