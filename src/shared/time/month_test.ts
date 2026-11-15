import { assertEquals } from "@std/assert";
import { lastDayOfNextMonth } from "./month.ts";

Deno.test("lastDayOfNextMonth: mês seguinte com 31 dias", () => {
  assertEquals(lastDayOfNextMonth("2026-08-21"), "2026-09-30");
  assertEquals(lastDayOfNextMonth("2026-09-01"), "2026-10-31");
});

Deno.test("lastDayOfNextMonth: Dezembro atravessa o ano", () => {
  // Sem normalização do ano, dava "2026-13-31" ou o mês errado.
  assertEquals(lastDayOfNextMonth("2026-12-31"), "2027-01-31");
  assertEquals(lastDayOfNextMonth("2026-11-15"), "2026-12-31");
});

Deno.test("lastDayOfNextMonth: Fevereiro, comum e bissexto", () => {
  // O prazo tem de existir no calendário: 2027 não tem 29 de Fevereiro.
  assertEquals(lastDayOfNextMonth("2027-01-10"), "2027-02-28");
  assertEquals(lastDayOfNextMonth("2028-01-10"), "2028-02-29");
});

Deno.test("lastDayOfNextMonth: o dia de origem é irrelevante", () => {
  // Só conta o mês: refaturar a 1 ou a 31 dá o mesmo prazo.
  assertEquals(lastDayOfNextMonth("2026-08-01"), lastDayOfNextMonth("2026-08-31"));
});
