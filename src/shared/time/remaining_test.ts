// WHY (Rule 9): o badge promete "quanto falta"; frase errada (plural, sobre-
// estimar, ou texto quando já passou) induz o admin em erro. Fixa a gramática
// e o arredondamento `floor`.

import { assertEquals } from "@std/assert";
import { formatRemaining } from "./remaining.ts";

const NOW = new Date("2026-06-03T10:00:00Z");
const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const inHours = (n: number) => new Date(NOW.getTime() + n * 3_600_000);
const inMinutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

Deno.test("formatRemaining: null devolve string vazia", () => {
  assertEquals(formatRemaining(null, NOW), "");
});

Deno.test("formatRemaining: instante no passado devolve vazio (cooldown acabou)", () => {
  assertEquals(formatRemaining(inHours(-1), NOW), "");
});

Deno.test("formatRemaining: exactamente agora devolve vazio", () => {
  assertEquals(formatRemaining(NOW, NOW), "");
});

Deno.test("formatRemaining: plural de dias", () => {
  assertEquals(formatRemaining(inDays(7), NOW), "faltam 7 dias");
});

Deno.test("formatRemaining: singular de dia", () => {
  // 1 dia e meio → floor = 1 dia (nunca sobre-estima).
  assertEquals(formatRemaining(inHours(36), NOW), "falta 1 dia");
});

Deno.test("formatRemaining: horas quando falta < 1 dia", () => {
  assertEquals(formatRemaining(inHours(5), NOW), "faltam 5 horas");
});

Deno.test("formatRemaining: singular de hora", () => {
  assertEquals(formatRemaining(inMinutes(90), NOW), "falta 1 hora");
});

Deno.test("formatRemaining: minutos quando falta < 1 hora", () => {
  assertEquals(formatRemaining(inMinutes(30), NOW), "faltam 30 minutos");
});

Deno.test("formatRemaining: menos de 1 minuto", () => {
  assertEquals(formatRemaining(new Date(NOW.getTime() + 30_000), NOW), "falta menos de 1 minuto");
});

Deno.test("formatRemaining: aceita ISO string (vem do JSON da API)", () => {
  assertEquals(formatRemaining(inDays(3).toISOString(), NOW), "faltam 3 dias");
});
