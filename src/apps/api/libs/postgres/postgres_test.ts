// Testa `toAppError` (SQLSTATE -> AppError). É privada ao módulo, por isso
// exercitamo-la via o error path do `query()` com um erro postgres-js falso -
// sem DB real.

import { assertEquals } from "@std/assert";
import { AppError } from "$api/libs/error/app_error.ts";
import { Postgres } from "./postgres.ts";

async function captureAppError(
  thrown: unknown,
): Promise<AppError> {
  const pg = new Postgres();
  try {
    await pg.query(() => Promise.reject(thrown));
    throw new Error("query() devia ter feito throw");
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
}

Deno.test("toAppError - 23505 unique_violation → 409 UNIQUE_VIOLATION", async () => {
  const err = await captureAppError({
    code: "23505",
    message: "duplicate key value violates unique constraint",
    constraint_name: "user_email_unique",
    table_name: "user",
  });
  assertEquals(err.statusCode, 409);
  assertEquals(err.code, "UNIQUE_VIOLATION");
  assertEquals(err.detail?.sqlState, "23505");
  assertEquals(err.detail?.constraint, "user_email_unique");
  assertEquals(err.detail?.table, "user");
});

Deno.test("toAppError - 23503 foreign_key_violation → 400", async () => {
  const err = await captureAppError({
    code: "23503",
    message: "insert or update violates foreign key",
  });
  assertEquals(err.statusCode, 400);
  assertEquals(err.code, "FOREIGN_KEY_VIOLATION");
});

Deno.test("toAppError - 23502 not_null_violation → 400", async () => {
  const err = await captureAppError({
    code: "23502",
    message: "null value in column violates not-null",
  });
  assertEquals(err.statusCode, 400);
  assertEquals(err.code, "NOT_NULL_VIOLATION");
});

Deno.test("toAppError - 23514 check_violation → 400", async () => {
  const err = await captureAppError({
    code: "23514",
    message: "check constraint violated",
  });
  assertEquals(err.statusCode, 400);
  assertEquals(err.code, "CHECK_VIOLATION");
});

Deno.test("toAppError - 40001 serialization_failure → 409 (retry-friendly)", async () => {
  const err = await captureAppError({
    code: "40001",
    message: "could not serialize access due to concurrent update",
  });
  assertEquals(err.statusCode, 409);
  assertEquals(err.code, "SERIALIZATION_FAILURE");
});

Deno.test("toAppError - 40P01 deadlock → 409", async () => {
  const err = await captureAppError({
    code: "40P01",
    message: "deadlock detected",
  });
  assertEquals(err.statusCode, 409);
  assertEquals(err.code, "DEADLOCK");
});

Deno.test("toAppError - 22001 string_data_right_truncation → 400 DATA_EXCEPTION", async () => {
  // Class 22 (data exception) - qualquer subcódigo cai aqui.
  const err = await captureAppError({
    code: "22001",
    message: "value too long for type",
  });
  assertEquals(err.statusCode, 400);
  assertEquals(err.code, "DATA_EXCEPTION");
});

Deno.test("toAppError - 08006 connection_failure → 503 DB_UNAVAILABLE", async () => {
  const err = await captureAppError({
    code: "08006",
    message: "connection failure",
  });
  assertEquals(err.statusCode, 503);
  assertEquals(err.code, "DB_UNAVAILABLE");
});

Deno.test("toAppError - 42601 syntax_error → 500 DB_QUERY_ERROR (bug nosso)", async () => {
  // Class 42 = syntax/access - indica bug no SQL gerado, não input do user.
  const err = await captureAppError({
    code: "42601",
    message: "syntax error at or near",
  });
  assertEquals(err.statusCode, 500);
  assertEquals(err.code, "DB_QUERY_ERROR");
});

Deno.test("toAppError - código SQLSTATE desconhecido → 500 DB_ERROR (catch-all)", async () => {
  const err = await captureAppError({
    code: "99999",
    message: "unknown",
  });
  assertEquals(err.statusCode, 500);
  assertEquals(err.code, "DB_ERROR");
});

Deno.test("toAppError - erro sem `.code` SQLSTATE → 500 DB_ERROR", async () => {
  const err = await captureAppError(new Error("network timeout"));
  assertEquals(err.statusCode, 500);
  assertEquals(err.code, "DB_ERROR");
  assertEquals(err.message, "network timeout");
});

Deno.test("toAppError - AppError passa através sem reclassificar", async () => {
  const original = new AppError({
    message: "ja é AppError",
    statusCode: 422,
    code: "BUSINESS_RULE",
  });
  const err = await captureAppError(original);
  // Idêntico ao original, não envolto.
  assertEquals(err, original);
  assertEquals(err.statusCode, 422);
  assertEquals(err.code, "BUSINESS_RULE");
});

Deno.test("toAppError - código mal-formado (não-5-char) → 500 DB_ERROR", async () => {
  // Defensive: se postgres-js emitir um `.code` que não é SQLSTATE de 5 chars
  // (improvável mas possível), caímos para o default sem crash.
  const err = await captureAppError({
    code: "ENOENT",
    message: "ficheiro não encontrado",
  });
  assertEquals(err.statusCode, 500);
  assertEquals(err.code, "DB_ERROR");
});
