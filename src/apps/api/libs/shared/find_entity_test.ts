// Unit tests para findEntityOrFail - o contrato 404 a seguir a cada findFirst.
// Correr:  deno test --allow-env src/apps/api/libs/shared/find_entity_test.ts

import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert";
import { findEntityOrFail } from "./find_entity.ts";
import { AppError } from "$api/libs/error/app_error.ts";

Deno.test("findEntityOrFail: devolve o próprio valor quando presente", () => {
  const row = { id: "u1" };
  // Tem de devolver a MESMA referência, não uma cópia.
  assertStrictEquals(findEntityOrFail(row, "Fração"), row);
});

Deno.test("findEntityOrFail: null atira 404 NOT_FOUND com o nome da entidade", () => {
  const err = assertThrows(() => findEntityOrFail(null, "Fração"), AppError);
  assertEquals(err.statusCode, 404);
  assertEquals(err.code, "NOT_FOUND");
  assertEquals(err.message, "Fração não encontrado");
});

Deno.test("findEntityOrFail: undefined também atira 404", () => {
  const err = assertThrows(() => findEntityOrFail(undefined, "Charge"), AppError);
  assertEquals(err.statusCode, 404);
  assertEquals(err.message, "Charge não encontrado");
});

Deno.test("findEntityOrFail: valores falsy não-nulos (0, '', false) passam", () => {
  // O guard é só null/undefined; um id 0 ou string vazia é um valor válido.
  assertEquals(findEntityOrFail(0, "X"), 0);
  assertEquals(findEntityOrFail("", "X"), "");
  assertEquals(findEntityOrFail(false, "X"), false);
});
