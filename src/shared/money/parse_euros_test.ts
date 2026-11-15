// Edge-cases que motivaram a centralização: variantes pré-existentes
// tinham comportamentos divergentes para vazio, NaN, negativos.

import { assertEquals } from "@std/assert";
import { parseEurosToCents } from "./parse_euros.ts";

Deno.test("parseEurosToCents: vírgula PT-PT", () => {
  assertEquals(parseEurosToCents("1.234,56"), 123456);
  assertEquals(parseEurosToCents("0,01"), 1);
  assertEquals(parseEurosToCents("10"), 1000);
});

Deno.test("parseEurosToCents: ponto decimal (formato API/intl)", () => {
  assertEquals(parseEurosToCents("1234.56"), 123456);
  assertEquals(parseEurosToCents("0.01"), 1);
});

Deno.test("parseEurosToCents: vazio/whitespace → null (não 0)", () => {
  // Decisão fundamental: vazio significa "não preenchido", não "0".
  // Caller decide se isso é erro.
  assertEquals(parseEurosToCents(""), null);
  assertEquals(parseEurosToCents("   "), null);
  assertEquals(parseEurosToCents(undefined), null);
  assertEquals(parseEurosToCents(null), null);
});

Deno.test("parseEurosToCents: NaN / texto inválido → null", () => {
  assertEquals(parseEurosToCents("abc"), null);
  assertEquals(parseEurosToCents("1.2.3"), null); // após replace fica "1.2.3"
});

Deno.test("parseEurosToCents: negativos → null por defeito", () => {
  // Charges/quotas não têm montantes negativos. Bloquear no parsing
  // evita propagar dados malformados.
  assertEquals(parseEurosToCents("-5,00"), null);
  assertEquals(parseEurosToCents("-5,00", { allowNegative: true }), -500);
  assertEquals(parseEurosToCents("0,00"), 0);
});

Deno.test("parseEurosToCents: arredondamento à 2.ª casa decimal", () => {
  // Regra do projeto: tudo em cêntimos integer. Se vier 3 casas, arredonda.
  assertEquals(parseEurosToCents("1,235"), 124); // .500 arredonda para cima
  assertEquals(parseEurosToCents("1,234"), 123);
  assertEquals(parseEurosToCents("0,005"), 1);
});

Deno.test("parseEurosToCents: tipos non-string passam pelo String()", () => {
  // Form data pode vir como string ou número - aceitamos os dois.
  assertEquals(parseEurosToCents(10), 1000);
  assertEquals(parseEurosToCents(0.01), 1);
});
