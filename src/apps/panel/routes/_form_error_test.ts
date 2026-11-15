import { assertEquals } from "@std/assert";
import { extractApiErrorMessage } from "./_form_error.ts";

// `runFormAction` puxa env (condoUrl); é coberto via e2e dos handlers.
// Aqui testamos só a função pura `extractApiErrorMessage` (zero deps).

Deno.test("extractApiErrorMessage: prefere apiErr.data.error.message (formato standard)", () => {
  const err = { data: { error: { message: "API rejeitou" } } };
  assertEquals(extractApiErrorMessage(err, "fallback."), "API rejeitou");
});

Deno.test("extractApiErrorMessage: cai para apiErr.message quando data.error.message ausente", () => {
  const err = { message: "Network error" };
  assertEquals(extractApiErrorMessage(err, "fallback."), "Network error");
});

Deno.test("extractApiErrorMessage: usa fallback quando erro não tem mensagens", () => {
  assertEquals(extractApiErrorMessage({}, "Erro ao criar fração."), "Erro ao criar fração.");
  assertEquals(extractApiErrorMessage(null, "Erro X."), "Erro X.");
  assertEquals(extractApiErrorMessage(undefined, "Erro Y."), "Erro Y.");
});

Deno.test("extractApiErrorMessage: data.error.message tem prioridade sobre message top-level", () => {
  // A ApiError do client tem ambos: o `message` é o status text generic, o
  // `data.error.message` é a mensagem específica do handler. Esta deve ganhar.
  const err = {
    message: "Bad Request",
    data: { error: { message: "Bank account já existe" } },
  };
  assertEquals(extractApiErrorMessage(err, "fallback."), "Bank account já existe");
});

Deno.test("extractApiErrorMessage: data.error sem message → cai para apiErr.message", () => {
  const err = {
    message: "Bad Request",
    data: { error: { code: "X" } }, // sem message
  };
  assertEquals(extractApiErrorMessage(err, "fallback."), "Bad Request");
});

// O "error during validation" não diz ao utilizador o que corrigir no formulário.
Deno.test("extractApiErrorMessage: VALIDATION_ERROR mostra as mensagens de detail.errors", () => {
  const err = {
    message: "Bad Request",
    data: {
      error: {
        code: "VALIDATION_ERROR",
        message: "error during validation",
        detail: { errors: [{ path: "fiscalNumber", message: "NIF deve ter 9 dígitos" }] },
      },
    },
  };
  assertEquals(extractApiErrorMessage(err, "fallback."), "NIF deve ter 9 dígitos");
});

Deno.test("extractApiErrorMessage: VALIDATION_ERROR com vários erros junta com '; '", () => {
  const err = {
    data: {
      error: {
        code: "VALIDATION_ERROR",
        message: "error during validation",
        detail: {
          errors: [
            { path: "name", message: "Nome obrigatório" },
            { path: "email", message: "" },
            { path: "fiscalNumber", message: "NIF deve ter 9 dígitos" },
          ],
        },
      },
    },
  };
  assertEquals(
    extractApiErrorMessage(err, "fallback."),
    "Nome obrigatório; NIF deve ter 9 dígitos",
  );
});

Deno.test("extractApiErrorMessage: VALIDATION_ERROR sem mensagens aproveitáveis → data.error.message", () => {
  // Handlers de negócio também usam o código VALIDATION_ERROR, sem detail.errors.
  const semDetail = {
    data: { error: { code: "VALIDATION_ERROR", message: "Data de fim antes do início" } },
  };
  assertEquals(extractApiErrorMessage(semDetail, "fallback."), "Data de fim antes do início");
  const detailVazio = {
    data: {
      error: {
        code: "VALIDATION_ERROR",
        message: "error during validation",
        detail: { errors: [] },
      },
    },
  };
  assertEquals(extractApiErrorMessage(detailVazio, "fallback."), "error during validation");
});

Deno.test("extractApiErrorMessage: detail.errors só conta com code VALIDATION_ERROR", () => {
  const err = {
    data: {
      error: { code: "CONFLICT", message: "Já existe", detail: { errors: [{ message: "x" }] } },
    },
  };
  assertEquals(extractApiErrorMessage(err, "fallback."), "Já existe");
});

Deno.test("extractApiErrorMessage: input sem shape esperado → fallback", () => {
  // Defesa: se err é string, number, etc, `.data` é undefined → fallback.
  assertEquals(extractApiErrorMessage("string error", "Erro."), "Erro.");
  assertEquals(extractApiErrorMessage(42, "Erro."), "Erro.");
});
