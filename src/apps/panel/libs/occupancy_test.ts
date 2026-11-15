import { assertEquals } from "@std/assert";
import { isOccupancyActive, splitOccupancies } from "./occupancy.ts";

const TODAY = "2026-08-03";

Deno.test("isOccupancyActive: sem data de fim = ativo (caso normal)", () => {
  assertEquals(isOccupancyActive({ endDate: null }, TODAY), true);
  assertEquals(isOccupancyActive({}, TODAY), true);
});

Deno.test("isOccupancyActive: fim marcado no futuro ainda é ocupante atual", () => {
  // O bug original: "sai em dezembro" fazia-o desaparecer no ato de gravar.
  assertEquals(isOccupancyActive({ endDate: "2026-12-31" }, TODAY), true);
});

Deno.test("isOccupancyActive: o próprio dia do fim ainda conta", () => {
  assertEquals(isOccupancyActive({ endDate: TODAY }, TODAY), true);
});

Deno.test("isOccupancyActive: fim já passado sai dos ativos", () => {
  assertEquals(isOccupancyActive({ endDate: "2026-08-02" }, TODAY), false);
});

Deno.test("splitOccupancies: separa mantendo a ordem de entrada", () => {
  const { active, past } = splitOccupancies([
    { id: "a", endDate: null },
    { id: "b", endDate: "2025-06-30" },
    { id: "c", endDate: "2026-12-31" },
    { id: "d", endDate: "2026-08-02" },
  ], TODAY);

  assertEquals(active.map((r) => r.id), ["a", "c"]);
  assertEquals(past.map((r) => r.id), ["b", "d"]);
});
