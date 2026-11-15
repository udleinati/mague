// Unit tests para os helpers puros de quota generation.
// Correr:  deno test --allow-env src/apps/api/modules/admin/budget/quota_distribution_test.ts

import { assertEquals, assertThrows } from "@std/assert";
import {
  computeInstallmentAmounts,
  computeInstallmentPeriods,
  computeMaxMonth,
  computeMonthlyWithFcr,
  distributeByPermillage,
  parseYearMonth,
} from "./quota_distribution.ts";

// ── computeMonthlyWithFcr ────────────────────────────────────────────────

Deno.test("computeMonthlyWithFcr: budget 12000€/ano sem FCR → 1000€/mês", () => {
  // 1.200.000 cêntimos / 12 = 100.000 cêntimos/mês
  const r = computeMonthlyWithFcr(1_200_000, 0);
  assertEquals(r.value, 100_000);
  assertEquals(r.rounded, 100_000);
});

Deno.test("computeMonthlyWithFcr: FCR 10% adiciona 10% ao monthly", () => {
  // 1.200.000 * 1.10 / 12 = 110.000
  const r = computeMonthlyWithFcr(1_200_000, 10);
  assertEquals(r.value, 110_000);
  assertEquals(r.rounded, 110_000);
});

Deno.test("computeMonthlyWithFcr: arredondamento quando divisão não é exata", () => {
  // 100€/ano sem FCR = 8.33...€/mês = 833.33 cêntimos
  const r = computeMonthlyWithFcr(10_000, 0);
  assertEquals(Math.abs(r.value - 833.33) < 0.01, true);
  assertEquals(r.rounded, 833);
});

Deno.test("computeMonthlyWithFcr: FCR 5.5% (não inteiro)", () => {
  // 1.200.000 * 1.055 / 12 = 105.500
  const r = computeMonthlyWithFcr(1_200_000, 5.5);
  assertEquals(r.rounded, 105_500);
});

// ── computeMaxMonth ──────────────────────────────────────────────────────

Deno.test("computeMaxMonth: through_date no mesmo ano devolve mês", () => {
  assertEquals(computeMaxMonth("2026-06-15", 2026), 6);
  assertEquals(computeMaxMonth("2026-12-31", 2026), 12);
  assertEquals(computeMaxMonth("2026-01-01", 2026), 1);
});

Deno.test("computeMaxMonth: through_date em ano posterior devolve 12", () => {
  assertEquals(computeMaxMonth("2027-03-15", 2026), 12);
  assertEquals(computeMaxMonth("2030-01-01", 2026), 12);
});

Deno.test("computeMaxMonth: through_date em ano anterior devolve 0 (no-op)", () => {
  assertEquals(computeMaxMonth("2025-12-31", 2026), 0);
  assertEquals(computeMaxMonth("2020-06-01", 2026), 0);
});

// ── distributeByPermillage ───────────────────────────────────────────────

Deno.test("distribuição uniforme: 4 units com 250‰ cada", () => {
  // monthly 100€ / 4 units = 25€ cada (sem diff a absorver)
  const monthly = computeMonthlyWithFcr(12_00 * 12, 0); // 14400 anual = 1200/mês
  const r = distributeByPermillage(
    monthly.value,
    monthly.rounded,
    [
      { id: "u1", permillage: 250 },
      { id: "u2", permillage: 250 },
      { id: "u3", permillage: 250 },
      { id: "u4", permillage: 250 },
    ],
    1000,
    "u1",
  );
  assertEquals(r.get("u1"), 300);
  assertEquals(r.get("u2"), 300);
  assertEquals(r.get("u3"), 300);
  assertEquals(r.get("u4"), 300);
  assertEquals([...r.values()].reduce((a, b) => a + b), 1200);
});

Deno.test("distribuição com diff de arredondamento absorvido pela big unit", () => {
  // monthly 1000 cêntimos / 3 units 333.33+333.33+333.33 → ROUND = 333+333+333 = 999
  // Diff = 1000 - 999 = 1, vai para big unit
  const r = distributeByPermillage(
    1000, // monthly value
    1000, // target rounded
    [
      { id: "big", permillage: 334 },
      { id: "u2", permillage: 333 },
      { id: "u3", permillage: 333 },
    ],
    1000,
    "big",
  );
  // big = round(1000*334/1000)=334, u2=u3=333. Sum=1000. Diff=0 → big stays 334.
  assertEquals(r.get("big"), 334);
  assertEquals(r.get("u2"), 333);
  assertEquals(r.get("u3"), 333);
  assertEquals([...r.values()].reduce((a, b) => a + b), 1000);
});

Deno.test("diff positivo (sub-distribuído) → big unit recebe +diff", () => {
  // monthly value 10, target 11 (forçado), 2 units 500‰ cada
  // round(10*500/1000)=5 cada. Sum=10. Diff = 11-10 = 1 → big +1
  const r = distributeByPermillage(
    10,
    11,
    [
      { id: "big", permillage: 500 },
      { id: "u2", permillage: 500 },
    ],
    1000,
    "big",
  );
  assertEquals(r.get("big"), 6);
  assertEquals(r.get("u2"), 5);
  assertEquals([...r.values()].reduce((a, b) => a + b), 11);
});

Deno.test("diff negativo (sobre-distribuído) → big unit recebe -diff", () => {
  // monthly value 10, target 9 (forçado), 2 units 500‰ cada
  // round(10*500/1000)=5 cada. Sum=10. Diff = 9-10 = -1 → big -1
  const r = distributeByPermillage(
    10,
    9,
    [
      { id: "big", permillage: 500 },
      { id: "u2", permillage: 500 },
    ],
    1000,
    "big",
  );
  assertEquals(r.get("big"), 4);
  assertEquals(r.get("u2"), 5);
  assertEquals([...r.values()].reduce((a, b) => a + b), 9);
});

Deno.test("permillages desiguais: cada um recebe proporcional", () => {
  // monthly 1000, units 600‰/300‰/100‰ (total 1000)
  // 600 + 300 + 100 = 1000 cêntimos
  const r = distributeByPermillage(
    1000,
    1000,
    [
      { id: "big", permillage: 600 },
      { id: "u2", permillage: 300 },
      { id: "u3", permillage: 100 },
    ],
    1000,
    "big",
  );
  assertEquals(r.get("big"), 600);
  assertEquals(r.get("u2"), 300);
  assertEquals(r.get("u3"), 100);
});

Deno.test("zero units: devolve Map vazio", () => {
  const r = distributeByPermillage(1000, 1000, [], 1000, null);
  assertEquals(r.size, 0);
});

Deno.test("totalPm = 0 → throws", () => {
  assertThrows(
    () => distributeByPermillage(1000, 1000, [{ id: "u1", permillage: 100 }], 0, "u1"),
    Error,
    "totalPm tem de ser > 0",
  );
});

// ── computeInstallmentAmounts (suplementar) ──────────────────────────────

Deno.test("computeInstallmentAmounts: obra 11.500€ em 3x sem FCR → soma exata", () => {
  // 1.150.000 cêntimos / 3 = 383.333,33 → [383333, 383333, 383334]
  const a = computeInstallmentAmounts(1_150_000, 0, 3);
  assertEquals(a, [383_333, 383_333, 383_334]);
  assertEquals(a.reduce((x, y) => x + y, 0), 1_150_000);
});

Deno.test("computeInstallmentAmounts: FCR 10% aplica-se ao total da obra", () => {
  // 1.150.000 * 1.10 = 1.265.000 ; /3 base=round(421666.67)=421667 ; resto na última
  const a = computeInstallmentAmounts(1_150_000, 10, 3);
  assertEquals(a.reduce((x, y) => x + y, 0), 1_265_000);
  assertEquals(a[0], 421_667);
  assertEquals(a[2], 1_265_000 - 421_667 * 2);
});

Deno.test("computeInstallmentAmounts: 1x devolve o total inteiro", () => {
  assertEquals(computeInstallmentAmounts(1_150_000, 0, 1), [1_150_000]);
});

Deno.test("computeInstallmentAmounts: soma = total*(1+fcr) para N arbitrário (invariante)", () => {
  for (const n of [1, 2, 4, 5, 6, 7, 12]) {
    const a = computeInstallmentAmounts(1_000_037, 7.3, n);
    const expected = Math.round(1_000_037 * 1.073);
    assertEquals(a.length, n);
    assertEquals(a.reduce((x, y) => x + y, 0), expected);
  }
});

Deno.test("computeInstallmentAmounts: n < 1 → throws", () => {
  assertThrows(() => computeInstallmentAmounts(1000, 0, 0), Error, "installments");
});

// ── computeInstallmentPeriods ────────────────────────────────────────────

Deno.test("computeInstallmentPeriods: 3 meses consecutivos no mesmo ano", () => {
  assertEquals(computeInstallmentPeriods(2026, 8, 3), [
    { year: 2026, month: 8 },
    { year: 2026, month: 9 },
    { year: 2026, month: 10 },
  ]);
});

Deno.test("computeInstallmentPeriods: cruza o ano (Nov + 5x → Mar do ano seguinte)", () => {
  assertEquals(computeInstallmentPeriods(2026, 11, 5), [
    { year: 2026, month: 11 },
    { year: 2026, month: 12 },
    { year: 2027, month: 1 },
    { year: 2027, month: 2 },
    { year: 2027, month: 3 },
  ]);
});

Deno.test("computeInstallmentPeriods: Dezembro rola para Janeiro", () => {
  assertEquals(computeInstallmentPeriods(2026, 12, 2), [
    { year: 2026, month: 12 },
    { year: 2027, month: 1 },
  ]);
});

Deno.test("computeInstallmentPeriods: n < 1 ou mês inválido → throws", () => {
  assertThrows(() => computeInstallmentPeriods(2026, 1, 0), Error, "installments");
  assertThrows(() => computeInstallmentPeriods(2026, 13, 3), Error, "mês inválido");
});

// ── parseYearMonth ───────────────────────────────────────────────────────

Deno.test("parseYearMonth: aceita YYYY-MM e YYYY-MM-DD", () => {
  assertEquals(parseYearMonth("2026-08"), { year: 2026, month: 8 });
  assertEquals(parseYearMonth("2026-08-15"), { year: 2026, month: 8 });
});

Deno.test("parseYearMonth: mês inválido → throws", () => {
  assertThrows(() => parseYearMonth("2026-13"), Error, "mês inválido");
});

// ── Integração: prestações × permilagem somam o total da obra ────────────

Deno.test("obra 11.500€ em 3x distribuída por 4 frações: soma = total exato", () => {
  const total = 1_150_000;
  const n = 3;
  const units = [
    { id: "u1", permillage: 300 },
    { id: "u2", permillage: 300 },
    { id: "u3", permillage: 250 },
    { id: "big", permillage: 150 },
  ];
  const totalPm = 1000;
  const amounts = computeInstallmentAmounts(total, 0, n);
  let grand = 0;
  for (const amount of amounts) {
    const dist = distributeByPermillage(amount, amount, units, totalPm, "big");
    const sum = [...dist.values()].reduce((a, b) => a + b, 0);
    assertEquals(sum, amount); // cada prestação fecha exatamente
    grand += sum;
  }
  assertEquals(grand, total); // as 3 prestações somam a obra inteira
});

Deno.test("Σ contribuições = monthlyWithFcrInt SEMPRE (invariante)", () => {
  // Caso patológico: 13 units com permillages primos para forçar diff de arredondamento.
  // Soma deve ainda assim ser exatamente igual ao target.
  const units = [
    { id: "u1", permillage: 71 },
    { id: "u2", permillage: 73 },
    { id: "u3", permillage: 79 },
    { id: "u4", permillage: 83 },
    { id: "u5", permillage: 89 },
    { id: "u6", permillage: 97 },
    { id: "u7", permillage: 101 },
    { id: "u8", permillage: 103 },
    { id: "u9", permillage: 107 },
    { id: "u10", permillage: 109 },
    { id: "big", permillage: 188 }, // big absorve diff
  ];
  const totalPm = units.reduce((s, u) => s + u.permillage, 0);
  const monthly = computeMonthlyWithFcr(13_473, 7.3); // valores arbitrários
  const r = distributeByPermillage(monthly.value, monthly.rounded, units, totalPm, "big");
  const sum = [...r.values()].reduce((a, b) => a + b, 0);
  assertEquals(sum, monthly.rounded);
});
