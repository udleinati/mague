import { assertEquals, assertThrows } from "@std/assert";
import { requireParam } from "./require_param.ts";
import { AppError } from "$api/libs/error/app_error.ts";

function fakeCtx(params: Record<string, string | undefined>) {
  return {
    req: {
      param: (name: string) => params[name],
    },
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("requireParam - devolve valor quando presente", () => {
  const ctx = fakeCtx({ id: "abc123" });
  assertEquals(requireParam(ctx, "id"), "abc123");
});

Deno.test("requireParam - atira AppError 400 quando ausente", () => {
  const ctx = fakeCtx({});
  const err = assertThrows(() => requireParam(ctx, "id"), AppError);
  assertEquals(err.statusCode, 400);
  assertEquals(err.code, "VALIDATION_ERROR");
  assertEquals(err.message, "id é obrigatório");
});

Deno.test("requireParam - string vazia conta como ausente", () => {
  const ctx = fakeCtx({ id: "" });
  assertThrows(() => requireParam(ctx, "id"), AppError, "id é obrigatório");
});

Deno.test("requireParam - usa o nome do param na mensagem", () => {
  const ctx = fakeCtx({});
  const err = assertThrows(() => requireParam(ctx, "chargeId"), AppError);
  assertEquals(err.message, "chargeId é obrigatório");
});
