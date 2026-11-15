// Unit tests para os helpers puros do recurring generator.
// Correr:  deno test --allow-env src/apps/api/modules/admin/recurring_template/date_helpers_test.ts

import { assertEquals, assertThrows } from "@std/assert";
import { advanceByInterval, monthStart } from "./date_helpers.ts";

// ── monthStart ────────────────────────────────────────────────────────

Deno.test("monthStart: meio do mês → dia 1", () => {
  assertEquals(monthStart("2026-04-15"), "2026-04-01");
});

Deno.test("monthStart: dia 1 fica igual", () => {
  assertEquals(monthStart("2026-04-01"), "2026-04-01");
});

Deno.test("monthStart: último dia do mês → dia 1 do mesmo mês", () => {
  assertEquals(monthStart("2026-12-31"), "2026-12-01");
});

// ── advanceByInterval ─────────────────────────────────────────────────

Deno.test("advanceByInterval monthly: +1 mês", () => {
  assertEquals(advanceByInterval("2026-04-15", "monthly"), "2026-05-15");
  assertEquals(advanceByInterval("2026-01-01", "monthly"), "2026-02-01");
});

Deno.test("advanceByInterval monthly: Dezembro → Janeiro do ano seguinte", () => {
  assertEquals(advanceByInterval("2026-12-15", "monthly"), "2027-01-15");
});

Deno.test("advanceByInterval bimonthly: +2 meses", () => {
  assertEquals(advanceByInterval("2026-03-10", "bimonthly"), "2026-05-10");
});

Deno.test("advanceByInterval bimonthly: Novembro → Janeiro do ano seguinte", () => {
  assertEquals(advanceByInterval("2026-11-15", "bimonthly"), "2027-01-15");
});

Deno.test("advanceByInterval quarterly: +3 meses", () => {
  assertEquals(advanceByInterval("2026-01-15", "quarterly"), "2026-04-15");
  assertEquals(advanceByInterval("2026-10-15", "quarterly"), "2027-01-15");
});

Deno.test("advanceByInterval semiannual: +6 meses", () => {
  assertEquals(advanceByInterval("2026-01-15", "semiannual"), "2026-07-15");
  assertEquals(advanceByInterval("2026-08-01", "semiannual"), "2027-02-01");
});

Deno.test("advanceByInterval annual: +1 ano (mesmo mês/dia)", () => {
  assertEquals(advanceByInterval("2026-06-15", "annual"), "2027-06-15");
  assertEquals(advanceByInterval("2026-12-31", "annual"), "2027-12-31");
});

Deno.test("advanceByInterval: interval inválido → throws", () => {
  assertThrows(
    () => advanceByInterval("2026-01-01", "weekly"),
    Error,
    "interval_type desconhecido: weekly",
  );
});

Deno.test("advanceByInterval: aplicado em sequência (12× monthly = annual)", () => {
  let date = "2026-01-15";
  for (let i = 0; i < 12; i++) {
    date = advanceByInterval(date, "monthly");
  }
  assertEquals(date, "2027-01-15");
});

Deno.test("advanceByInterval: aplicado em sequência (4× quarterly = annual)", () => {
  let date = "2026-01-01";
  for (let i = 0; i < 4; i++) {
    date = advanceByInterval(date, "quarterly");
  }
  assertEquals(date, "2027-01-01");
});

Deno.test("advanceByInterval: passar por ano bissexto sem perder dia", () => {
  // 2024 é bissexto. Mantém o dia tal como veio (não normaliza Fev 29).
  assertEquals(advanceByInterval("2023-12-29", "monthly"), "2024-01-29");
  assertEquals(advanceByInterval("2024-01-29", "monthly"), "2024-02-29");
});
