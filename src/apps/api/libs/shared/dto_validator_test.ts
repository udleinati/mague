// Unit tests para dtoValidator - o formato do erro 400 que o app.onError serializa.
// Correr:  deno test --allow-env src/apps/api/libs/shared/dto_validator_test.ts

import { assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";
import { dtoValidator } from "./dto_validator.ts";
import { AppError } from "$api/libs/error/app_error.ts";

const Schema = z.object({
  name: z.string(),
  amountCents: z.number().int(),
  nested: z.object({ nif: z.string() }),
});

Deno.test("dtoValidator: input válido devolve o valor parseado", async () => {
  const out = await dtoValidator(Schema, {
    name: "Ana",
    amountCents: 1500,
    nested: { nif: "123456789" },
  });
  assertEquals(out.name, "Ana");
  assertEquals(out.amountCents, 1500);
});

Deno.test("dtoValidator: input inválido atira AppError 400 VALIDATION_ERROR", async () => {
  const err = await assertRejects(
    () => dtoValidator(Schema, { name: 123, amountCents: "x", nested: { nif: "ok" } }),
    AppError,
  );
  assertEquals(err.statusCode, 400);
  assertEquals(err.code, "VALIDATION_ERROR");
});

Deno.test("dtoValidator: detail.errors lista cada issue com path pontuado", async () => {
  // O frontend mapeia erros por campo via este path; o ponto na nested é o contrato.
  const err = await assertRejects(
    () => dtoValidator(Schema, { name: "Ana", amountCents: 10, nested: { nif: 99 } }),
    AppError,
  );
  const errors = err.detail?.errors as Array<{ path: string; message: string }>;
  const paths = errors.map((e) => e.path);
  assertEquals(paths.includes("nested.nif"), true);
  // cada entrada traz mensagem não-vazia para mostrar ao utilizador
  assertEquals(errors.every((e) => typeof e.message === "string" && e.message.length > 0), true);
});

Deno.test("dtoValidator: erro na raiz (tipo errado no topo) usa path 'root'", async () => {
  // path vazio (z.array no topo, input não-array) tem de virar "root", não "".
  const err = await assertRejects(
    () => dtoValidator(z.array(z.string()), "não é array"),
    AppError,
  );
  const errors = err.detail?.errors as Array<{ path: string }>;
  assertEquals(errors[0].path, "root");
});
