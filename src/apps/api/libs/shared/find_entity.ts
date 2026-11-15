import { AppError } from "$api/libs/error/app_error.ts";

/**
 * Lança `AppError(NOT_FOUND)` se `value` for null/undefined; senão devolve
 * `value` (NonNullable). Encurta o `if (!x) throw ...` depois de um `findFirst`.
 */
export function findEntityOrFail<T>(
  value: T | null | undefined,
  entityName: string,
): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new AppError({
      message: `${entityName} não encontrado`,
      statusCode: 404,
      code: "NOT_FOUND",
    });
  }
  return value as NonNullable<T>;
}
