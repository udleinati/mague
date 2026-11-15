import { assertEquals } from "@std/assert";
import { isValidPortugueseNif } from "./nif.ts";

Deno.test("NIF vazio devolve false", () => {
  assertEquals(isValidPortugueseNif(""), false);
});

Deno.test("NIF válido (123456789) devolve true", () => {
  // Singular (prefixo 1): Σ=156, 156 mod 11 = 2, check = 9 (bate último dígito).
  assertEquals(isValidPortugueseNif("123456789"), true);
});

Deno.test("NIF com último dígito errado devolve false", () => {
  // Mesmo NIF anterior, mas check digit 0 em vez de 9.
  assertEquals(isValidPortugueseNif("123456780"), false);
});

Deno.test("NIF com 8 dígitos (curto) devolve false", () => {
  assertEquals(isValidPortugueseNif("12345678"), false);
});

Deno.test("NIF com 10 dígitos (longo) devolve false", () => {
  assertEquals(isValidPortugueseNif("1234567890"), false);
});

Deno.test("NIF com letras devolve false (não NaN)", () => {
  // `Number("a")` é NaN e NaN === number é sempre false; teste explícito
  // protege contra uma refactor futura que use parseInt.
  assertEquals(isValidPortugueseNif("12345678a"), false);
  assertEquals(isValidPortugueseNif("abcdefghi"), false);
});

Deno.test("NIF começado por dígito não-permitido (4) devolve false", () => {
  // 4, 7, 0 não são prefixos atribuídos. "400000008" tem checksum válido,
  // logo prova que a rejeição vem do prefixo, não do checksum.
  assertEquals(isValidPortugueseNif("400000008"), false);
});

Deno.test("NIF de empresa (começa por 5) devolve true", () => {
  // Σ=45, 45 mod 11 = 1, check = 0 (porque resto <= 1).
  assertEquals(isValidPortugueseNif("500000000"), true);
});
