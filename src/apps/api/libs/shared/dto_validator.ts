import { z } from "zod";
import { AppError } from "$api/libs/error/app_error.ts";

/**
 * Valida `input` contra `schema`. Devolve o valor parseado em sucesso;
 * lança `AppError(VALIDATION_ERROR, 400)` em falha - apanhado pelo
 * `app.onError` da API e convertido em JSON 400.
 */
export async function dtoValidator<T>(schema: z.ZodType<T>, input: unknown): Promise<T> {
  const result = await schema.safeParseAsync(input);
  if (result.success) return result.data as T;
  throw new AppError({
    message: "error during validation",
    statusCode: 400,
    code: "VALIDATION_ERROR",
    detail: { errors: result.error.issues.map(parseValidationError) },
  });
}

function parseValidationError(err: z.ZodIssue): Record<string, unknown> {
  const path = err.path.join(".");
  return { path: path || "root", message: err.message };
}
