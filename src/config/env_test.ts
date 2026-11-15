// Testa só os helpers exportados de `env.ts`: importar `env` dispara `required`
// (DATABASE_URL/SESSION_SECRET) e `Deno.exit` em falta.

import { assertEquals, assertThrows } from "@std/assert";
import { asEmailProvider } from "./env.ts";

Deno.test("asEmailProvider: smtp → smtp", () => {
  assertEquals(asEmailProvider("smtp"), "smtp");
});

Deno.test("asEmailProvider: resend-http → resend-http", () => {
  assertEquals(asEmailProvider("resend-http"), "resend-http");
});

Deno.test("asEmailProvider: valor inválido → throw com mensagem clara", () => {
  // Mensagem tem de listar os valores aceites para o operador corrigir o typo sem ler código.
  const err = assertThrows(
    () => asEmailProvider("resend"),
    Error,
    "EMAIL_PROVIDER inválido",
  );
  assertEquals(err.message.includes('"smtp"'), true);
  assertEquals(err.message.includes('"resend-http"'), true);
  assertEquals(err.message.includes('"resend"'), true);
});

Deno.test("asEmailProvider: string vazia → throw", () => {
  assertThrows(() => asEmailProvider(""), Error, "EMAIL_PROVIDER inválido");
});

Deno.test("asEmailProvider: case-sensitive (SMTP em maiúsculas é inválido)", () => {
  // Rebentamos em vez de normalizar: env vars são case-sensitive em Linux/Docker.
  assertThrows(() => asEmailProvider("SMTP"), Error);
});
